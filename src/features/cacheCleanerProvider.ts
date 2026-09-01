import { basename, dirname, isAbsolute, relative } from 'node:path';
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

/** The workspace folder a cache was found under, kept beside it so the delete
 *  can prove containment rather than trusting the path it was handed. */
type FoundCache = StaleCache & { root: string };

/** How many folders the notification names before it gives up and counts. VS
 *  Code notifications are one line and strip newlines outright
 *  (microsoft/vscode#101589), so a long list would be truncated mid-path —
 *  which is worse than no list. Past this the "Review…" picker is the answer. */
const NAMED_IN_PROMPT = 3;

/** Opens the picker below. The ellipsis is VS Code's convention for a button
 *  that leads to more UI rather than acting immediately. */
const REVIEW = 'Review…';

/** What to call a cache in the UI: the module directory it belongs to, relative
 *  to the workspace folder it was found under. `.terraform` is the same name
 *  every time and tells the reader nothing; the module path is what they
 *  recognise, and it keeps the user's home directory out of a screenshot. Falls
 *  back to the absolute path if the cache somehow does not sit under its root. */
function moduleLabel(dir: string, root: string): string {
  const mod = dirname(dir);
  const rel = relative(root, mod);
  if (rel === '') return basename(root) || root;
  return rel.startsWith('..') || isAbsolute(rel) ? mod : rel;
}

/** ISO, never a locale format: this renders next to a Delete button, and a
 *  dd/mm-vs-mm/dd misread is exactly the kind of mistake that costs a cache. */
function activityDate(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : 'unknown';
}

/** `.terraform/providers, .terraform/modules` — the actual directories that go. */
function victimList(c: StaleCache): string {
  return c.entries.map((e) => `.terraform/${e}`).join(', ');
}

function nameList(caches: FoundCache[]): string {
  const names = caches.map((c) => moduleLabel(c.dir, c.root));
  if (names.length <= NAMED_IN_PROMPT) return names.join(', ');
  return `${names.slice(0, NAMED_IN_PROMPT).join(', ')} and ${names.length - NAMED_IN_PROMPT} more`;
}

interface CacheItem extends vscode.QuickPickItem {
  cache: FoundCache;
}

/** The list the notification cannot show. Everything is pre-checked, so Enter
 *  is the same answer as "Delete all" — but the user has now seen the absolute
 *  path, the size, the last-activity date and the exact subdirectories for
 *  every single cache, and can uncheck any of them. */
async function review(caches: FoundCache[], days: number): Promise<FoundCache[] | undefined> {
  const items: CacheItem[] = caches.map((c) => ({
    label: moduleLabel(c.dir, c.root),
    description: `${formatSize(c.sizeBytes)} · last activity ${activityDate(c.lastActivityMs)}`,
    detail: `${c.dir} — deletes ${victimList(c)}`,
    picked: true,
    cache: c,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Stale .terraform caches — no activity for over ${days} days`,
    placeHolder: 'Uncheck anything you want to keep, then press Enter to delete the rest',
    // a destructive list must not disappear because the user clicked away to go
    // and look at one of the paths it is asking about
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  return picked?.map((i) => i.cache);
}

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

/** The whole feature: walk, prompt, delete, report. Exported so the prompt and
 *  the review picker can be driven against a real temp tree in tests — this is
 *  the only code path that can delete a user's cache, and asserting on the
 *  notification text is the only way to prove it names what it is about to
 *  remove. `registerCacheCleaner` is the sole production caller. */
export async function scan(
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
  const days = effectiveStaleDays(staleDays);
  const snooze = (ms: number) =>
    Promise.resolve(state.update(SNOOZE_KEY, Date.now() + ms)).then(undefined, (e) =>
      log(`cacheCleaner: could not record the snooze: ${e}`),
    );

  const stale: FoundCache[] = [];
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
  // the full inventory, always, whether or not a prompt is shown — with
  // autoDelete on this is the only record of what was about to go
  for (const c of unique) {
    log(
      `cacheCleaner: stale ${c.dir} (${formatSize(c.sizeBytes)}, last activity ${activityDate(c.lastActivityMs)}) — will delete ${victimList(c)}`,
    );
  }

  let targets = unique;
  if (!cacheCleanerAutoDelete()) {
    const plural = unique.length === 1 ? '' : 's';
    const deleteLabel = unique.length === 1 ? 'Delete' : `Delete all ${unique.length}`;
    // The folders are named, not just counted. "N .terraform folders, delete?"
    // gave the user nothing to check the answer against, so the only available
    // reply was a blind yes — and Review… puts the full list, with paths and
    // sizes, one click away for when the names do not fit.
    const choice = await vscode.window.showWarningMessage(
      `Terraform Companion: stale .terraform cache${plural} in ${nameList(unique)} — no activity for over ${days} days, about ${formatSize(total)} of cached providers and modules. Delete? terraform init recreates them, and your state, selected workspace and backend config are kept.`,
      REVIEW,
      deleteLabel,
      'Ignore',
    );
    if (choice === REVIEW) {
      const picked = await review(unique, days);
      // escaped, or unchecked everything: both mean "not now"
      if (picked === undefined || picked.length === 0) {
        await snooze(IGNORE_SNOOZE_MS);
        return;
      }
      targets = picked;
    } else if (choice !== deleteLabel) {
      // "Ignore" used to buy nothing: the identical prompt returned on the next
      // window open, forever, which is how a destructive prompt gets
      // click-throughed. Dismissing it now actually holds.
      await snooze(IGNORE_SNOOZE_MS);
      return;
    }
  }
  // caches the user looked at and deliberately kept. Without a snooze they are
  // re-offered on the next window open, which trains exactly the click-through
  // the prompt is trying to avoid.
  const kept = unique.length - targets.length;

  let freed = 0;
  const cleaned: FoundCache[] = [];
  let failed = 0;
  for (const c of targets) {
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
      if (result.removed.length === 0) {
        log(`cacheCleaner: nothing reclaimable in ${c.dir}`);
        continue;
      }
      cleaned.push(c);
      freed += c.sizeBytes;
      log(`cacheCleaner: cleaned ${c.dir} — removed ${result.removed.join(', ')}`);
    } catch (e) {
      failed++;
      log(`cacheCleaner: failed to clean ${c.dir}: ${e}`);
    }
  }
  if (kept > 0) await snooze(IGNORE_SNOOZE_MS);
  // A partial delete is the case that matters: `rm -rf` removes files until it
  // hits EACCES, and the half-populated provider tree left behind makes
  // `terraform init` fail with "could not find executable file" instead of
  // re-downloading. Reporting only to the output channel meant the user clicked
  // Delete on a destructive prompt and got no feedback at all.
  if (failed > 0) {
    vscode.window
      .showWarningMessage(
        `Terraform Companion: ${failed} .terraform cache${failed === 1 ? '' : 's'} could not be cleaned${cleaned.length > 0 ? ` (${cleaned.length} succeeded)` : ''}. See the Terraform Companion output channel for details.`,
      )
      .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
  }
  if (cleaned.length === 0) return;
  // caught, not voided: this fires after a walk that may have taken a while, so
  // the window can be closing by now and a rejection would land on the
  // extension host as an unhandled one
  vscode.window
    .showInformationMessage(
      `Terraform Companion: cleaned the .terraform cache in ${nameList(cleaned)}, freed ${formatSize(freed)}. Those modules will need terraform init next time.`,
    )
    .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
}
