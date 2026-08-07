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

  private diagnosticsFor(file: ParsedFile): vscode.Diagnostic[] {
    return this.computeFindings(file).map((f) => {
      const diag = new vscode.Diagnostic(toRange(f.span), f.message, severityFor(f.code));
      diag.source = 'tf-companion';
      diag.code = f.code;
      return diag;
    });
  }

  /** Whether a settings change can alter any diagnostic this pipeline emits.
   *
   *  `affectsConfiguration('tfCompanion')` is true for every key in the
   *  section, so dragging `cacheCleaner.staleDays` or `versionLens.
   *  cacheTtlHours` in the Settings UI re-linted the entire workspace — one
   *  `publish` per indexed file, each firing its own diagnostics-changed event
   *  — for a value no rule reads. A section prefix already covers its children,
   *  so `versionHygiene` catches `versionHygiene.variableDocs`. */
  affects(e: vscode.ConfigurationChangeEvent): boolean {
    return this.rules.some((rule) => e.affectsConfiguration(`tfCompanion.${rule.feature}`));
  }

  refreshAll(): void {
    this.collection.clear();
    // index-dependent rules (unused locals, cross-file count refs) can change
    // without the buffer changing, so the per-revision cache must not survive
    this.actionCache = undefined;
    // one bulk set instead of one event per file: the Problems view and every
    // editor's decoration layer react to each diagnostics-changed event, and a
    // 2000-file workspace fired 2000 of them. Files with nothing to report get
    // `undefined` rather than an empty array, so the collection stops holding
    // an entry per indexed file.
    const entries: [vscode.Uri, vscode.Diagnostic[] | undefined][] = [];
    for (const file of this.index.files()) {
      const diagnostics = this.diagnosticsFor(file);
      entries.push([vscode.Uri.file(file.path), diagnostics.length > 0 ? diagnostics : undefined]);
    }
    this.collection.set(entries);
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
    // One bulk set, for exactly the reason refreshAll uses one. Publishing per
    // file fired a diagnostics-changed event each, and `unusedLocals` is
    // module-scoped and on by default — so a single keystroke re-published
    // every .tf in the module directory, one event apiece. Clean files get
    // `undefined` rather than `[]`, so the collection stops holding an entry
    // per file, which is what `refreshAll` is careful about too.
    //
    // `plan.drop` and `plan.publish` cannot name the same uri (drop is exactly
    // the paths the index no longer has, publish comes from the index), so the
    // documented merging of duplicate tuples cannot turn a replace into an
    // append here.
    const entries: [vscode.Uri, vscode.Diagnostic[] | undefined][] = [];
    for (const path of plan.drop) entries.push([vscode.Uri.file(path), undefined]);
    for (const file of plan.publish) {
      const diagnostics = this.diagnosticsFor(file);
      entries.push([vscode.Uri.file(file.path), diagnostics.length > 0 ? diagnostics : undefined]);
    }
    if (entries.length > 0) this.collection.set(entries);
  }

  /** Findings for the live buffer: a fix applied through the debounced index's
   *  stale spans would edit the wrong lines. Memoised per revision, since VS Code
   *  asks on every cursor move and recomputing means a full re-parse. */
  private liveFindings(document: vscode.TextDocument): LintFinding[] {
    const key = `${document.uri.toString()}@${document.version}`;
    if (this.actionCache?.key === key) return this.actionCache.findings;
    // The parser recurses over the CST without a depth bound, so deeply nested
    // HCL raises RangeError. This is a CodeActionProvider callback, which VS
    // Code drives from cursor movement, so an uncaught throw here repeats on
    // every keystroke in such a buffer. The two sibling providers already wrap
    // this exact call for this exact reason; this one did not.
    let findings: LintFinding[];
    try {
      findings = this.computeFindings(
        parseFile(normalizePath(document.uri.fsPath), document.getText()),
      );
    } catch (e) {
      this.log?.(`Live findings failed on ${document.uri.fsPath}: ${e}`);
      findings = [];
    }
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
