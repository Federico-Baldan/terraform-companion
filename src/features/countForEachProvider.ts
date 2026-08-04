import * as vscode from 'vscode';
import { featureEnabled } from '../config';
import type { TfvarsValue } from '../core/evaluator';
import type { ParsedFile } from '../core/model';
import { parseFile } from '../core/parser';
import { normalizePath, type WorkspaceIndex } from '../core/workspaceIndex';
import { toRange } from '../vscodeUtils';
import { detectCountLength, rewriteToForEach } from './countForEach';

/** Kept structural so the refactor does not depend on the hover feature. */
export interface TfvarsSource {
  /** the tfvars in force for a module directory */
  valuesFor(moduleDir: string): ReadonlyMap<string, TfvarsValue>;
}

/** Multi-edit refactor: count = length(list) → for_each. Only the fix is
 *  gated on `safeToRefactor` — the warning never depends on selected tfvars. */
export function registerCountForEach(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  tfvars?: TfvarsSource,
): void {
  /** The buffer's parse, memoised per revision.
   *
   *  VS Code asks every code-action provider on each selection change, so this
   *  ran ~4x a second while the caret moved, and a 3000-line main.tf costs
   *  10-25ms of tree-sitter plus a full walk allocating every block and ref.
   *
   *  Only the parse is cached. `detectCountLength` still re-runs, so the lazy
   *  `safeToRefactor` analysis is recomputed rather than remembered — it also
   *  depends on the active tfvars pin, which changes in `workspaceState`
   *  without touching the index, and serving a stale verdict there would offer
   *  a destructive rewrite the current pin does not justify. */
  let parseCache: { key: string; file: ParsedFile | undefined } | undefined;
  const parseCached = (doc: vscode.TextDocument, path: string): ParsedFile | undefined => {
    const key = `${doc.uri.toString()}@${doc.version}`;
    if (parseCache?.key === key) return parseCache.file;
    let file: ParsedFile | undefined;
    try {
      file = parseFile(path, doc.getText());
    } catch {
      // unbounded CST recursion throws RangeError on a half-typed file. Cached
      // like any other result, so it costs one parse and not one per cursor move.
      file = undefined;
    }
    parseCache = { key, file };
    return file;
  };

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      // scheme 'file': the rewrite edits a real file, so skip read-only
      // virtual docs (git diff views)
      [{ scheme: 'file', pattern: '**/*.tf' }],
      {
        provideCodeActions(doc, range, ctx) {
          // the setting gates the whole feature — the diagnostic is filtered in
          // the lint pipeline, but this refactor is a separate provider, so the
          // RefactorRewrite action would keep showing in the light-bulb menu
          // (it is offered by kind, independent of any diagnostic) unless the
          // flag is checked here too
          if (!featureEnabled('countForEach')) return [];
          // only files the index knows — anywhere else every cross-file safety
          // check sees an empty module and silently passes, exactly when this
          // destructive rewrite must not be offered
          const path = normalizePath(doc.uri.fsPath);
          if (!index.file(path)) return [];
          // the index is debounced, and stale spans would corrupt the rewrite
          const file = parseCached(doc, path);
          if (!file) return [];
          const actions: vscode.CodeAction[] = [];
          for (const pattern of detectCountLength(file, index, {
            tfvarsOf: (dir) => tfvars?.valuesFor(dir) ?? new Map(),
          })) {
            // range first: VS Code asks for code actions on every cursor move,
            // and `safeToRefactor` is the lazy cross-file safety analysis whose
            // own comment puts it at ~100x the detection. Reading it before the
            // range filter paid that for every counted block in the file rather
            // than the one under the caret — the laziness the detector went to
            // trouble for, spent by its only caller.
            if (!range.intersection(toRange(pattern.countAttr.span))) continue;
            if (!pattern.safeToRefactor) continue;
            const action = new vscode.CodeAction(
              'Refactor: count → for_each',
              vscode.CodeActionKind.RefactorRewrite,
            );
            action.edit = new vscode.WorkspaceEdit();
            for (const e of rewriteToForEach(pattern)) {
              action.edit.replace(doc.uri, toRange(e.span), e.newText);
            }
            // only this block's diagnostic: with two count blocks in one file,
            // filtering by code alone attached both, so each action claimed to
            // fix the other block's warning too
            action.diagnostics = ctx.diagnostics.filter(
              (d) =>
                d.code === 'count.lengthPattern' &&
                !!d.range.intersection(toRange(pattern.countAttr.span)),
            );
            actions.push(action);
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    ),
  );
}
