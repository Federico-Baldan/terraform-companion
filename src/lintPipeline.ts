import * as vscode from 'vscode';
import { featureEnabled } from './config';
import type { LintFinding, ParsedFile } from './core/model';
import { parseFile } from './core/parser';
import { normalizePath, type WorkspaceIndex } from './core/workspaceIndex';
import { type LintRule, planRelint } from './lintScope';
import { toRange } from './vscodeUtils';

export type { LintRule } from './lintScope';

function severityFor(code: string): vscode.DiagnosticSeverity {
  if (code === 'hygiene.variableDocs') {
    return vscode.DiagnosticSeverity.Hint;
  }
  if (code === 'hygiene.unboundedConstraint') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

const FIX_TITLES: Record<string, string> = {
  'dependsOn.redundant': 'Remove the redundant dependencies',
};

export class LintPipeline {
  private collection: vscode.DiagnosticCollection;
  /** last code-action computation, keyed by document identity + revision */
  private actionCache?: { key: string; findings: LintFinding[] };

  constructor(
    private rules: LintRule[],
    private index: WorkspaceIndex,
    private log?: (m: string) => void,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection('tf-companion');
  }

  dispose(): void {
    this.collection.dispose();
  }

  private computeFindings(file: ParsedFile): LintFinding[] {
    const fileFindings: LintFinding[] = [];
    for (const rule of this.rules) {
      if (!featureEnabled(rule.feature) || !rule.appliesTo(file.path)) continue;
      try {
        fileFindings.push(...rule.run(file, this.index));
      } catch (e) {
        // a broken detector must never break the pipeline
        this.log?.(`Lint rule "${rule.feature}" failed on ${file.path}: ${e}`);
      }
    }
    return fileFindings;
  }

  private publish(file: ParsedFile): void {
    this.collection.set(
      vscode.Uri.file(file.path),
      this.computeFindings(file).map((f) => {
        const diag = new vscode.Diagnostic(toRange(f.span), f.message, severityFor(f.code));
        diag.source = 'tf-companion';
        diag.code = f.code;
        return diag;
      }),
    );
  }

  refreshAll(): void {
    this.collection.clear();
    // index-dependent rules (unused locals, cross-file count refs) can change
    // without the buffer changing, so the per-revision cache must not survive
    this.actionCache = undefined;
    for (const file of this.index.files()) this.publish(file);
  }

  /** Re-lint only what an edit to `paths` can have changed. Nothing outside the
   *  planned set is touched, so diagnostics already published stay as they were. */
  refreshPaths(paths: readonly string[]): void {
    if (paths.length === 0) return;
    this.actionCache = undefined;
    const plan = planRelint(
      this.index,
      paths,
      this.rules.some((rule) => rule.scope === 'module' && featureEnabled(rule.feature)),
    );
    for (const path of plan.drop) this.collection.delete(vscode.Uri.file(path));
    for (const file of plan.publish) this.publish(file);
  }

  /** Findings for the live buffer: a fix applied through the debounced index's
   *  stale spans would edit the wrong lines. Memoised per revision, since VS Code
   *  asks on every cursor move and recomputing means a full re-parse. */
  private liveFindings(document: vscode.TextDocument): LintFinding[] {
    const key = `${document.uri.toString()}@${document.version}`;
    if (this.actionCache?.key === key) return this.actionCache.findings;
    const findings = this.computeFindings(
      parseFile(normalizePath(document.uri.fsPath), document.getText()),
    );
    this.actionCache = { key, findings };
    return findings;
  }

  codeActionsFor(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const fileFindings = this.liveFindings(document);
    const diagnostics = this.collection.get(document.uri) ?? [];
    const actions: vscode.CodeAction[] = [];
    for (const f of fileFindings) {
      if (!f.fix || !range.intersection(toRange(f.span))) continue;
      const action = new vscode.CodeAction(
        FIX_TITLES[f.code] ?? 'Apply fix',
        vscode.CodeActionKind.QuickFix,
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, toRange(f.fix.span), f.fix.newText);
      // Findings come from the live buffer, the collection from the debounced
      // index, so the ranges drift between a keystroke and the next refresh.
      // Exact equality unlinked the fix, which "Fix all" then skips.
      const span = toRange(f.span);
      action.diagnostics = diagnostics.filter(
        (d) => d.code === f.code && !!d.range.intersection(span),
      );
      actions.push(action);
    }
    return actions;
  }
}

/** Creates the pipeline, registers its quick-fix provider and runs a first pass. */
export function registerLintPipeline(
  context: vscode.ExtensionContext,
  rules: LintRule[],
  index: WorkspaceIndex,
  log?: (m: string) => void,
): LintPipeline {
  const pipeline = new LintPipeline(rules, index, log);
  context.subscriptions.push(
    { dispose: () => pipeline.dispose() },
    vscode.languages.registerCodeActionsProvider(
      // scheme:'file': a fix offered in a git diff view can never be applied
      [
        { scheme: 'file', pattern: '**/*.tf' },
        { scheme: 'file', pattern: '**/*.tfvars' },
      ],
      { provideCodeActions: (doc, range) => pipeline.codeActionsFor(doc, range) },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
  pipeline.refreshAll();
  return pipeline;
}
