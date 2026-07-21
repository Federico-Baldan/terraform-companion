import * as vscode from 'vscode';
import { featureEnabled } from '../config';
import type { TfvarsValue } from '../core/evaluator';
import { parseFile } from '../core/parser';
import { normalizePath, type WorkspaceIndex } from '../core/workspaceIndex';
import { toRange } from '../vscodeUtils';
import { detectCountLength, rewriteToForEach } from './countForEach';

/** Kept structural so the refactor does not depend on the hover feature. */
export interface TfvarsSource {
  /** the tfvars in force for a module directory */
  valuesFor(moduleDir: string): Map<string, TfvarsValue>;
}

/** Multi-edit refactor: count = length(list) → for_each. Only the fix is
 *  gated on `safeToRefactor` — the warning never depends on selected tfvars. */
export function registerCountForEach(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  tfvars?: TfvarsSource,
): void {
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
          const file = parseFile(path, doc.getText());
          const actions: vscode.CodeAction[] = [];
          for (const pattern of detectCountLength(file, index, {
            tfvarsOf: (dir) => tfvars?.valuesFor(dir) ?? new Map(),
          })) {
            if (!pattern.safeToRefactor) continue;
            if (!range.intersection(toRange(pattern.countAttr.span))) continue;
            const action = new vscode.CodeAction(
              'Refactor: count → for_each',
              vscode.CodeActionKind.RefactorRewrite,
            );
            action.edit = new vscode.WorkspaceEdit();
            for (const e of rewriteToForEach(pattern)) {
              action.edit.replace(doc.uri, toRange(e.span), e.newText);
            }
            action.diagnostics = ctx.diagnostics.filter((d) => d.code === 'count.lengthPattern');
            actions.push(action);
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    ),
  );
}
