import { basename, dirname, isAbsolute, relative } from 'node:path';
import * as vscode from 'vscode';
import {
  cacheCleanerAutoDelete,
  cacheCleanerSharedPluginCache,
  cacheCleanerStaleDays,
  featureEnabled,
} from '../config';
import {
  collectProviderSources,
  configuredProviderCache,
  deleteCachePayload,
  deleteProviderCacheEntry,
  effectiveStaleDays,
  findStaleProviderCacheEntries,
  findStaleTerraformDirs,
  formatSize,
  isProviderEntryStillStale,
  isStillStale,
  isTerraformCacheDir,
  type ProviderCacheEntry,
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

interface ProviderItem extends vscode.QuickPickItem {
  entry: ProviderCacheEntry;
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

/** The provider sources the workspace's lock files, and its initialised
 *  projects, still need — and whether every one of them was read. */
async function readLockSources(
  folders: readonly { uri: { fsPath: string } }[],
  cancelled: () => boolean,
  log: (m: string) => void,
): Promise<{ sources: Set<string>; complete: boolean }> {
  const sources = new Set<string>();
  let complete = folders.length > 0;
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    try {
      const locks = await collectProviderSources(root, cancelled);
      for (const source of locks.sources) sources.add(source);
      if (!locks.complete) complete = false;
    } catch (e) {
      complete = false;
      log(`cacheCleaner: lock file scan failed in ${root}: ${e}`);
    }
  }
  return { sources, complete };
}

async function reviewProviders(
  entries: ProviderCacheEntry[],
  days: number,
): Promise<ProviderCacheEntry[] | undefined> {
  const items: ProviderItem[] = entries.map((entry) => ({
    label: `${entry.source} ${basename(entry.dir)}`,
    description: `${formatSize(entry.sizeBytes)} · last written ${activityDate(entry.lastActivityMs)}`,
    detail: entry.dir,
    picked: true,
    entry,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Shared Terraform plugin cache: provider versions installed over ${days} days ago`,
    placeHolder: 'Uncheck anything you want to keep, then press Enter to delete the rest',
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  return picked?.map((item) => item.entry);
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

  const providerCacheOn = cacheCleanerSharedPluginCache();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const stale: FoundCache[] = [];
  const protectedSources = new Set<string>();
  // The workspace's lock files are the only thing that protects a provider from
  // the shared-cache sweep, so any doubt about them — no folder open, one that
  // would not scan, a lock file that would not read — switches the sweep off for
  // this run. An incomplete set does not mean "protects less", it means "offers
  // for deletion exactly what the unread lock file named".
  let lockFilesRead = folders.length > 0;
  for (const folder of folders) {
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
    if (!providerCacheOn) continue;
    // its own step: a failed .terraform walk must not skip the lock files
    const locks = await readLockSources([folder], cancelled, log);
    for (const source of locks.sources) protectedSources.add(source);
    if (!locks.complete) lockFilesRead = false;
  }
  // workspace folders may nest — VS Code allows both /repo and /repo/infra —
  // and a cache under both is found once per folder. Counted twice it inflates
  // the number and the size in the prompt, and the second delete of an
  // already-deleted path succeeds silently and inflates the result too.
  const unique = [...new Map(stale.map((c) => [c.dir, c])).values()];
  if (cancelled()) return;
  const providerCache = providerCacheOn ? await configuredProviderCache(log) : undefined;
  let staleProviders: ProviderCacheEntry[] = [];
  if (providerCache) {
    if (lockFilesRead) {
      staleProviders = await findStaleProviderCacheEntries(
        providerCache,
        protectedSources,
        staleDays,
        Date.now(),
        cancelled,
      );
    } else {
      log(
        folders.length === 0
          ? 'cacheCleaner: provider cache left alone — no workspace folder is open, so no lock file can say what is in use'
          : 'cacheCleaner: provider cache left alone — not every lock file in the workspace could be read',
      );
    }
  }
  // a walk cut short found "nothing" only because it did not finish, and
  // recording that as a quiet period would hide what it never reached
  if (cancelled()) return;
  if (unique.length === 0 && staleProviders.length === 0) {
    await snooze(QUIET_SCAN_MS);
    return;
  }

  if (unique.length > 0) {
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
          targets = [];
        } else {
          targets = picked;
        }
      } else if (choice !== deleteLabel) {
        // "Ignore" used to buy nothing: the identical prompt returned on the next
        // window open, forever, which is how a destructive prompt gets
        // click-throughed. Dismissing it now actually holds.
        await snooze(IGNORE_SNOOZE_MS);
        targets = [];
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
    if (cleaned.length > 0 && !cacheCleanerAutoDelete()) {
      // caught, not voided: this fires after a walk that may have taken a while,
      // so the window can be closing by now and a rejection would be unhandled
      vscode.window
        .showInformationMessage(
          `Terraform Companion: cleaned the .terraform cache in ${nameList(cleaned)}, freed ${formatSize(freed)}. Those modules will need terraform init next time.`,
        )
        .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
    }
  }

  if (staleProviders.length === 0 || !providerCache) return;
  const providerTotal = staleProviders.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  for (const entry of staleProviders) {
    log(
      `cacheCleaner: stale provider ${entry.source} ${basename(entry.dir)} (${formatSize(entry.sizeBytes)}, last activity ${activityDate(entry.lastActivityMs)})`,
    );
  }
  // Always asked, `autoDelete` or not. That switch covers a workspace's own
  // `.terraform`, which `terraform init` rebuilds; this cache is shared by every
  // Terraform project on the machine, and a provider deleted from it leaves the
  // symlink in each project that used it dangling.
  const count = staleProviders.length;
  const them = count === 1 ? 'it' : 'them';
  // worded unlike the .terraform prompt's `Delete all N`, which can sit right
  // before this one: the same button twice invites answering the second unread
  const deleteLabel = `Delete ${count} version${count === 1 ? '' : 's'}`;
  const choice = await vscode.window.showWarningMessage(
    // "installed", not "unused": Terraform never writes to a cache entry again
    // after installing it, so what the date measures is the install, not the use
    `Terraform Companion: the shared plugin cache (${providerCache}) holds ${count} provider version${count === 1 ? '' : 's'} installed over ${days} days ago that no lock file in this workspace names, about ${formatSize(providerTotal)}. Other projects on this machine may still use ${them} and would need terraform init again. Delete?`,
    REVIEW,
    deleteLabel,
    'Ignore',
  );
  let providerTargets = staleProviders;
  if (choice === REVIEW) {
    const picked = await reviewProviders(staleProviders, days);
    // escaped, or unchecked everything: both mean "not now"
    if (!picked || picked.length === 0) {
      await snooze(IGNORE_SNOOZE_MS);
      return;
    }
    providerTargets = picked;
  } else if (choice !== deleteLabel) {
    // same reasoning as for .terraform: an ignored prompt that returns on the
    // next window open is a prompt people learn to click through
    await snooze(IGNORE_SNOOZE_MS);
    return;
  }
  const providerKept = staleProviders.length - providerTargets.length;

  // Reuse leaves no trace in the cache — Terraform links an entry and never
  // writes to it — so the only way to learn that a provider became needed while
  // the prompt was open is to read the lock files again, now.
  const fresh = await readLockSources(folders, cancelled, log);
  if (cancelled()) return;
  if (!fresh.complete) {
    log(
      'cacheCleaner: provider cache left alone — the lock files could not all be read again after the prompt',
    );
    // the click was Delete: saying nothing would read as "done"
    vscode.window
      .showWarningMessage(
        'Terraform Companion: left the shared plugin cache alone. The lock files in the workspace could not all be read again after you answered, so nothing was removed.',
      )
      .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
    return;
  }
  let providerSpared = 0;
  providerTargets = providerTargets.filter((entry) => {
    if (!fresh.sources.has(entry.source)) return true;
    log(`cacheCleaner: skipped provider ${entry.dir} (a lock file names it now)`);
    providerSpared++;
    return false;
  });

  let providerFreed = 0;
  let providerCleaned = 0;
  let providerFailed = 0;
  for (const entry of providerTargets) {
    if (cancelled()) return;
    // the prompt may have sat open while another project ran terraform init
    if (!(await isProviderEntryStillStale(entry.dir, staleDays))) {
      log(`cacheCleaner: skipped provider ${entry.dir} (used since the scan)`);
      providerSpared++;
      continue;
    }
    const result = await deleteProviderCacheEntry(entry, providerCache);
    if (!result.ok) {
      providerFailed++;
      log(`cacheCleaner: left provider ${entry.dir} alone: ${result.reason}`);
      continue;
    }
    providerCleaned++;
    providerFreed += entry.sizeBytes;
    log(`cacheCleaner: cleaned provider ${entry.dir}`);
  }
  if (providerKept > 0) await snooze(IGNORE_SNOOZE_MS);
  if (providerFailed > 0) {
    vscode.window
      .showWarningMessage(
        `Terraform Companion: ${providerFailed} provider version${providerFailed === 1 ? '' : 's'} could not be removed from the shared plugin cache. See the Terraform Companion output channel for details.`,
      )
      .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
  }
  const outcome: string[] = [];
  if (providerCleaned > 0)
    outcome.push(
      `removed ${providerCleaned} provider version${providerCleaned === 1 ? '' : 's'} from the shared plugin cache, freed ${formatSize(providerFreed)}. A project that used ${providerCleaned === 1 ? 'it' : 'them'} needs terraform init next time.`,
    );
  // a Delete that spared something should say so, not look like it did nothing
  if (providerSpared > 0)
    outcome.push(
      `${outcome.length > 0 ? 'Kept' : 'kept'} ${providerSpared} provider version${providerSpared === 1 ? '' : 's'} because a project started using ${providerSpared === 1 ? 'it' : 'them'} while the prompt was open.`,
    );
  if (outcome.length > 0) {
    vscode.window
      .showInformationMessage(`Terraform Companion: ${outcome.join(' ')}`)
      .then(undefined, (e) => log(`cacheCleaner: notification failed: ${e}`));
  }
}
