import { rm } from 'node:fs/promises';
import * as vscode from 'vscode';
import { cacheCleanerAutoDelete, cacheCleanerStaleDays, featureEnabled } from '../config';
import {
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
  const timer = setTimeout(() => void scan(log, () => disposed), 5_000);
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
    try {
      stale.push(
        ...(await findStaleTerraformDirs(folder.uri.fsPath, staleDays, Date.now(), (dir) =>
          log(`cacheCleaner: depth limit reached, not scanned below ${dir}`),
        )),
      );
    } catch (e) {
      log(`cacheCleaner: scan failed in ${folder.uri.fsPath}: ${e}`);
    }
  }
  if (stale.length === 0 || cancelled()) return;

  const total = stale.reduce((s, c) => s + c.sizeBytes, 0);
  for (const c of stale) log(`cacheCleaner: stale ${c.dir} (${formatSize(c.sizeBytes)})`);
  if (!cacheCleanerAutoDelete()) {
    const choice = await vscode.window.showWarningMessage(
      `Terraform Companion: ${stale.length} .terraform folder${stale.length === 1 ? '' : 's'} with no activity for over ${effectiveStaleDays(staleDays)} days (${formatSize(total)}). Delete them? They are only caches: terraform init recreates them (the selected workspace resets to default, and a module initialised with -backend-config needs those flags again).`,
      'Delete',
      'Ignore',
    );
    if (choice !== 'Delete') return;
  }

  let freed = 0;
  let deleted = 0;
  for (const c of stale) {
    if (cancelled()) return;
    if (!isTerraformCacheDir(c.dir)) continue; // hard guard: only .terraform dirs
    // the prompt may have sat open for a long time
    if (!(await isStillStale(c.dir, staleDays))) {
      log(`cacheCleaner: skipped ${c.dir} (used since the scan)`);
      continue;
    }
    try {
      await rm(c.dir, { recursive: true, force: true });
      deleted++;
      freed += c.sizeBytes;
      log(`cacheCleaner: deleted ${c.dir}`);
    } catch (e) {
      log(`cacheCleaner: failed to delete ${c.dir}: ${e}`);
    }
  }
  if (deleted === 0) return;
  void vscode.window.showInformationMessage(
    `Terraform Companion: deleted ${deleted} stale .terraform cache${deleted === 1 ? '' : 's'}, freed ${formatSize(freed)}. Those modules will need terraform init (and terraform workspace select, if they used workspaces) next time.`,
  );
}
