import * as vscode from 'vscode';
import { cacheCleanerAutoDelete, cacheCleanerStaleDays, featureEnabled } from '../config';
import {
  deleteCachePayload,
  effectiveStaleDays,
  findStaleTerraformDirs,
  formatSize,
  isStillStale,
  isTerraformCacheDir,
  type StaleCache,
} from './cacheCleaner';

export function registerCacheCleaner(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
): void {
  // deferred: scanning disk sizes must never slow down activation
  let disposed = false;
  // caught rather than voided: nothing is awaiting this, so a rejection would
  // land on the extension host as an unhandled one
  const timer = setTimeout(() => {
    scan(log, () => disposed).catch((e) => log(`cacheCleaner: scan failed: ${e}`));
  }, 5_000);
  // clearTimeout only helps before the 5s elapses — a scan already walking the
  // disk needs its own stop signal, or it deletes caches after deactivation
  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  });
}

async function scan(log: (m: string) => void, cancelled: () => boolean): Promise<void> {
  if (!featureEnabled('cacheCleaner')) return;
  const staleDays = cacheCleanerStaleDays();

  const stale: StaleCache[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    // a multi-root workspace must not start the next folder's walk either
    if (cancelled()) return;
    try {
      stale.push(
        ...(await findStaleTerraformDirs(
          folder.uri.fsPath,
          staleDays,
          Date.now(),
          (dir) => log(`cacheCleaner: depth limit reached, not scanned below ${dir}`),
          cancelled,
        )),
      );
    } catch (e) {
      log(`cacheCleaner: scan failed in ${folder.uri.fsPath}: ${e}`);
    }
  }
  // workspace folders may nest — VS Code allows both /repo and /repo/infra —
  // and a cache under both is found once per folder. Counted twice it inflates
  // the number and the size in the prompt, and the second delete of an
  // already-deleted path succeeds silently and inflates the result too.
  const unique = [...new Map(stale.map((c) => [c.dir, c])).values()];
  if (unique.length === 0 || cancelled()) return;

  const total = unique.reduce((s, c) => s + c.sizeBytes, 0);
  for (const c of unique) log(`cacheCleaner: stale ${c.dir} (${formatSize(c.sizeBytes)})`);
  if (!cacheCleanerAutoDelete()) {
    const choice = await vscode.window.showWarningMessage(
      `Terraform Companion: ${unique.length} .terraform folder${unique.length === 1 ? '' : 's'} with no activity for over ${effectiveStaleDays(staleDays)} days (${formatSize(total)}). Delete the cached providers and modules? terraform init recreates them, and the selected workspace and backend config are kept.`,
      'Delete',
      'Ignore',
    );
    if (choice !== 'Delete') return;
  }

  let freed = 0;
  let deleted = 0;
  for (const c of unique) {
    if (cancelled()) return;
    if (!isTerraformCacheDir(c.dir)) continue; // hard guard: only .terraform dirs
    // the prompt may have sat open for a long time
    if (!(await isStillStale(c.dir, staleDays))) {
      log(`cacheCleaner: skipped ${c.dir} (used since the scan)`);
      continue;
    }
    try {
      await deleteCachePayload(c.dir);
      deleted++;
      freed += c.sizeBytes;
      log(`cacheCleaner: cleaned ${c.dir}`);
    } catch (e) {
      log(`cacheCleaner: failed to clean ${c.dir}: ${e}`);
    }
  }
  if (deleted === 0) return;
  // caught, not voided: this fires after a walk that may have taken a while, so
  // the window can be closing by now and a rejection would land on the
  // extension host as an unhandled one
  vscode.window
    .showInformationMessage(
      `Terraform Companion: cleaned ${deleted} stale .terraform cache${deleted === 1 ? '' : 's'}, freed ${formatSize(freed)}. Those modules will need terraform init next time.`,
    )
    .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
}
