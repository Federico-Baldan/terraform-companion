import * as vscode from 'vscode';
import { featureEnabled } from '../config';
import { parseFile } from '../core/parser';
import { normalizePath } from '../core/workspaceIndex';
import type { RegistryClient } from '../registry/client';
import { latestAdmitted, latestStable, lensText } from '../registry/constraints';
import { isExcludedTfPath, toRange } from '../vscodeUtils';
import {
  computeVersionTargets,
  registryUrl,
  updateChoiceLabel,
  updatedConstraintText,
  type VersionTarget,
} from './versionLens';

export const UPDATE_COMMAND = 'tfCompanion.updateVersion';

export class VersionLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private client: RegistryClient) {}

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!featureEnabled('versionLens')) {
      return [];
    }
    // a bump lens under .terraform/ edits a file the next init overwrites
    if (isExcludedTfPath(document.uri.fsPath)) return [];
    // parse the live buffer — the index is debounced and its spans may be
    // stale, which would anchor lenses on the wrong lines
    const file = parseFile(normalizePath(document.uri.fsPath), document.getText());
    // parallel: the client dedupes and caches, so a cold file does not serialise
    const resolved = await Promise.all(
      computeVersionTargets(file).map(async (target) => ({
        target,
        versions: target.isModule
          ? await this.client.moduleVersions(target.source)
          : await this.client.providerVersions(target.source),
      })),
    );
    if (token.isCancellationRequested) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const { target, versions } of resolved) {
      if (!versions) continue; // offline / unknown: show nothing, never an error
      // two facts, and the title needs both: what the constraint resolves to
      // today, and what exists at all
      const newest = latestStable(versions);
      if (!newest) continue;
      // may be undefined when the constraint admits nothing published (a yanked
      // pin); lensText says so rather than leaving the line bare
      const installed = latestAdmitted(versions, target.constraint);
      const title = lensText(target.constraint, installed, newest);
      if (!title) continue;
      lenses.push(
        new vscode.CodeLens(toRange(target.span), {
          title,
          command: UPDATE_COMMAND,
          arguments: [document.uri, target, newest],
        }),
      );
    }
    return lenses;
  }
}

/** The lens's target may be stale by click time (the buffer can change
 *  between lens computation and the QuickPick choice), so the edit applies to
 *  a fresh re-parse: same source and constraint, nearest to where it was. */
function relocateTarget(
  doc: vscode.TextDocument,
  target: VersionTarget,
): VersionTarget | undefined {
  const candidates = computeVersionTargets(
    parseFile(normalizePath(doc.uri.fsPath), doc.getText()),
  ).filter(
    (t) =>
      t.isModule === target.isModule &&
      t.source === target.source &&
      t.constraint === target.constraint,
  );
  candidates.sort(
    (a, b) =>
      Math.abs(a.valueSpan.start.row - target.valueSpan.start.row) -
      Math.abs(b.valueSpan.start.row - target.valueSpan.start.row),
  );
  return candidates[0];
}

export function registerVersionLens(
  context: vscode.ExtensionContext,
  client: RegistryClient,
): VersionLensProvider {
  const provider = new VersionLensProvider(client);
  context.subscriptions.push(
    // scheme:'file': in a git diff view "Update to …" silently does nothing
    vscode.languages.registerCodeLensProvider([{ scheme: 'file', pattern: '**/*.tf' }], provider),
    vscode.commands.registerCommand(
      UPDATE_COMMAND,
      async (uri: vscode.Uri, target: VersionTarget, latest: string) => {
        const update = updateChoiceLabel(target, latest);
        const open = 'Open in the registry';
        const choice = await vscode.window.showQuickPick([update, open], {
          placeHolder: `${target.source}: ${latest} available`,
        });
        if (choice === update) {
          const doc = await vscode.workspace.openTextDocument(uri);
          const fresh = relocateTarget(doc, target);
          if (!fresh) {
            void vscode.window.showInformationMessage(
              `${target.source}: the constraint changed in the meantime — no update applied`,
            );
            return;
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, toRange(fresh.valueSpan), updatedConstraintText(fresh, latest));
          await vscode.workspace.applyEdit(edit);
        } else if (choice === open) {
          await vscode.env.openExternal(vscode.Uri.parse(registryUrl(target)));
        }
      },
    ),
  );
  return provider;
}
