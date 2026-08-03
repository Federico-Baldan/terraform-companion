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

/** Enough that a normal file still resolves in one round trip, low enough that
 *  a generated `versions.tf` cannot open a connection per provider. */
const MAX_CONCURRENT_REGISTRY_REQUESTS = 6;

export class VersionLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private client: RegistryClient) {}

  refresh(): void {
    this.emitter.fire();
  }

  /** Every other resource here is disposed — the diagnostic collection, the
   *  status bar item, the watchers. This emitter was the one that outlived
   *  deactivation, so a reload left its listeners attached. */
  dispose(): void {
    this.emitter.dispose();
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
    // Parallel, but bounded: the client dedupes and caches, so a cold file does
    // not serialise — yet an unbounded fan-out meant one `required_providers`
    // block with forty distinct providers opened forty simultaneous
    // connections, each holding its own 8s timeout, multiplied again per
    // visible editor in a split view.
    //
    // The cancellation check moved inside the loop for the same reason it is
    // bounded: checking only after the fan-out settled discarded the result but
    // never stopped the work, so closing the file still paid for every request.
    const targets = computeVersionTargets(file);
    const resolved: { target: VersionTarget; versions: string[] | undefined }[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        if (token.isCancellationRequested) return;
        const slot = next++;
        const target = targets[slot];
        if (!target) continue;
        const versions = target.isModule
          ? await this.client.moduleVersions(target.source)
          : await this.client.providerVersions(target.source);
        resolved[slot] = { target, versions };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_REGISTRY_REQUESTS, targets.length) }, worker),
    );
    if (token.isCancellationRequested) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const entry of resolved) {
      // assigned by slot, so a run stopped by cancellation leaves holes
      if (!entry) continue;
      const { target, versions } = entry;
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
    { dispose: () => provider.dispose() },
    // scheme:'file': in a git diff view "Update to …" silently does nothing
    vscode.languages.registerCodeLensProvider([{ scheme: 'file', pattern: '**/*.tf' }], provider),
    vscode.commands.registerCommand(
      UPDATE_COMMAND,
      async (uri: vscode.Uri, target: VersionTarget, latest: string) => {
        const update = updateChoiceLabel(target, latest);
        const open = 'Open in the registry';
        // A `~>` bump keeps the precision that was written, so `~> 5.98` with
        // 5.98.1 as the newest produces `~> 5.98` again — byte-identical to
        // what is already there. Offering that promised a change that could not
        // happen, and taking it replaced the range with itself: the file went
        // dirty and an undo stop was pushed for nothing. Common shape, since
        // two-segment `~>` pins are how most providers are written.
        //
        // Resolved against the live buffer rather than the lens's own text, so
        // an edit made since the lens was drawn is caught by the same check.
        const doc = await vscode.workspace.openTextDocument(uri);
        const fresh = relocateTarget(doc, target);
        const updated = fresh && updatedConstraintText(fresh, latest);
        const isNoOp = fresh !== undefined && updated === doc.getText(toRange(fresh.valueSpan));
        const choice = await vscode.window.showQuickPick(isNoOp ? [open] : [update, open], {
          placeHolder: isNoOp
            ? `${target.source}: ${latest} is already allowed by this constraint`
            : `${target.source}: ${latest} available`,
        });
        if (choice === update) {
          if (!fresh || updated === undefined) {
            void vscode.window.showInformationMessage(
              `${target.source}: the constraint changed in the meantime — no update applied`,
            );
            return;
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, toRange(fresh.valueSpan), updated);
          await vscode.workspace.applyEdit(edit);
        } else if (choice === open) {
          await vscode.env.openExternal(vscode.Uri.parse(registryUrl(target)));
        }
      },
    ),
  );
  return provider;
}
