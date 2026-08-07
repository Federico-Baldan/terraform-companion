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

/** How long a scan that found nothing buys before the disk is walked again, and
 *  how long "Ignore" holds. The walk is the expensive half of this feature —
 *  `dist`, `build`, `target` and `vendor` are deliberately in scope, so on a
 *  monorepo it is hundreds of thousands of entries — and it ran unconditionally
 *  5s into every activation. Every window on the same repo paid it separately,
 *  and since the answer was recorded nowhere, "Ignore" bought nothing: the same
 *  prompt returned on the next launch, forever, which is exactly how a
 *  destructive prompt gets click-throughed. */
const QUIET_SCAN_MS = 24 * 3_600_000;
const IGNORE_SNOOZE_MS = 7 * 24 * 3_600_000;
const SNOOZE_KEY = 'cacheCleaner.snoozeUntil';

export function registerCacheCleaner(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
): void {
  // deferred: scanning disk sizes must never slow down activation
  let disposed = false;
  // caught rather than voided: nothing is awaiting this, so a rejection would
  // land on the extension host as an unhandled one
  const timer = setTimeout(() => {
    scan(log, () => disposed, context.globalState).catch((e) =>
      log(`cacheCleaner: scan failed: ${e}`),
    );
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

async function scan(
  log: (m: string) => void,
  cancelled: () => boolean,
  state: vscode.Memento,
): Promise<void> {
  if (!featureEnabled('cacheCleaner')) return;
  const snoozeUntil = state.get<number>(SNOOZE_KEY) ?? 0;
  // a clock moved backwards must not snooze the feature out of existence
  if (
    Number.isFinite(snoozeUntil) &&
    Date.now() < snoozeUntil &&
    snoozeUntil - Date.now() <= IGNORE_SNOOZE_MS
  ) {
    log(`cacheCleaner: skipping the walk until ${new Date(snoozeUntil).toISOString()}`);
    return;
  }
  const staleDays = cacheCleanerStaleDays();
  const snooze = (ms: number) =>
    Promise.resolve(state.update(SNOOZE_KEY, Date.now() + ms)).then(undefined, (e) =>
      log(`cacheCleaner: could not record the snooze: ${e}`),
    );

  // the workspace root each cache was found under, so the delete can prove
  // containment rather than trusting the path it was handed
  const stale: (StaleCache & { root: string })[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    // a multi-root workspace must not start the next folder's walk either
    if (cancelled()) return;
    const root = folder.uri.fsPath;
    try {
      const found = await findStaleTerraformDirs(
        root,
        staleDays,
        Date.now(),
        (dir) => log(`cacheCleaner: depth limit reached, not scanned below ${dir}`),
        cancelled,
      );
      for (const c of found) stale.push({ ...c, root });
    } catch (e) {
      log(`cacheCleaner: scan failed in ${root}: ${e}`);
    }
  }
  // workspace folders may nest — VS Code allows both /repo and /repo/infra —
  // and a cache under both is found once per folder. Counted twice it inflates
  // the number and the size in the prompt, and the second delete of an
  // already-deleted path succeeds silently and inflates the result too.
  const unique = [...new Map(stale.map((c) => [c.dir, c])).values()];
  if (cancelled()) return;
  if (unique.length === 0) {
    // nothing stale: don't re-walk the whole workspace on the next window open
    await snooze(QUIET_SCAN_MS);
    return;
  }

  const total = unique.reduce((s, c) => s + c.sizeBytes, 0);
  for (const c of unique) log(`cacheCleaner: stale ${c.dir} (${formatSize(c.sizeBytes)})`);
  if (!cacheCleanerAutoDelete()) {
    const choice = await vscode.window.showWarningMessage(
      `Terraform Companion: ${unique.length} .terraform folder${unique.length === 1 ? '' : 's'} with no activity for over ${effectiveStaleDays(staleDays)} days (about ${formatSize(total)}). Delete the cached providers and modules? terraform init recreates them, and the selected workspace and backend config are kept.`,
      'Delete',
      'Ignore',
    );
    if (choice !== 'Delete') {
      // "Ignore" used to buy nothing: the identical prompt returned on the next
      // window open, forever, which is how a destructive prompt gets
      // click-throughed. Dismissing it now actually holds.
      await snooze(IGNORE_SNOOZE_MS);
      return;
    }
  }

  let freed = 0;
  let deleted = 0;
  let failed = 0;
  for (const c of unique) {
    if (cancelled()) return;
    if (!isTerraformCacheDir(c.dir)) continue; // hard guard: only .terraform dirs
    // the prompt may have sat open for a long time
    if (!(await isStillStale(c.dir, staleDays))) {
      log(`cacheCleaner: skipped ${c.dir} (used since the scan)`);
      continue;
    }
    try {
      // the result is load-bearing: a refusal — including the symlink guard
      // firing, the one case it exists for — used to be indistinguishable from
      // success here, so the bytes were counted as freed and the only record of
      // the guard doing its job was no record at all
      const result = await deleteCachePayload(c.dir, c.root);
      if (!result.ok) {
        failed++;
        log(`cacheCleaner: left ${c.dir} alone: ${result.reason}`);
        continue;
      }
      // A delete that removed nothing is not a clean. `rm --force` succeeds on
      // an absent path and the plugins guard can decline every entry, so an
      // already-empty cache and one nothing may reclaim both came back ok —
      // and both were counted as freed bytes. Two windows on the same repo
      // double-counted the same cache this way.
      if (result.removed === 0) {
        log(`cacheCleaner: nothing reclaimable in ${c.dir}`);
        continue;
      }
      deleted++;
      freed += c.sizeBytes;
      log(`cacheCleaner: cleaned ${c.dir}`);
    } catch (e) {
      failed++;
      log(`cacheCleaner: failed to clean ${c.dir}: ${e}`);
    }
  }
  // A partial delete is the case that matters: `rm -rf` removes files until it
  // hits EACCES, and the half-populated provider tree left behind makes
  // `terraform init` fail with "could not find executable file" instead of
  // re-downloading. Reporting only to the output channel meant the user clicked
  // Delete on a destructive prompt and got no feedback at all.
  if (failed > 0) {
    vscode.window
      .showWarningMessage(
        `Terraform Companion: ${failed} .terraform cache${failed === 1 ? '' : 's'} could not be cleaned${deleted > 0 ? ` (${deleted} succeeded)` : ''}. See the Terraform Companion output channel for details.`,
      )
      .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
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
