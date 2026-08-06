import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

export interface StaleCache {
  dir: string;
  sizeBytes: number;
  lastActivityMs: number;
}

/** Dependency and VCS trees only — dist, build, target, vendor stay out since
 *  generated Terraform can live there. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  // terragrunt's scratch tree — mtimes belong to the checkout, not the user's
  // work, and terragrunt regenerates it anyway
  '.terragrunt-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.next',
  '.nuxt',
]);
/** Deep enough for any real layout, and a backstop against a symlink cycle.
 *  Logged when hit, since anything below goes unreported. */
const MAX_DEPTH = 32;

/** Floor and fallback for `staleDays`, applied here (not in settings) since
 *  this feeds `rm -rf`. Zero or negative would match every cache including
 *  one built seconds ago, and VS Code doesn't enforce package.json's
 *  `minimum`. Non-numeric falls back to the default, not the floor — a
 *  garbled setting must not become the most aggressive sweep. */
const MIN_STALE_DAYS = 1;
const DEFAULT_STALE_DAYS = 30;

/** The window actually enforced. Exported so the prompt quotes what the scan
 *  used, not the raw setting. */
export function effectiveStaleDays(staleDays: number): number {
  return Number.isFinite(staleDays) ? Math.max(staleDays, MIN_STALE_DAYS) : DEFAULT_STALE_DAYS;
}

/** The instant before which a module counts as abandoned, with the floor applied. */
function staleCutoff(staleDays: number, now: number): number {
  return now - effectiveStaleDays(staleDays) * 86_400_000;
}

/** The only things inside .terraform that are really cache: provider binaries and
 *  module checkouts, which between them are effectively all of the bytes.
 *  Everything else there is metadata `terraform init` cannot reconstruct on its
 *  own — `environment` holds the selected workspace, `terraform.tfstate` the
 *  resolved backend config — so removing the whole directory silently resets a
 *  user's workspace selection and drops the flags a `-backend-config` module was
 *  initialised with, to reclaim a few hundred bytes.
 *
 *  `plugins` is the pre-0.14 spelling of `providers`. Omitting it made exactly
 *  the caches this feature targets — old enough to have gone 30 days untouched
 *  — size to zero and drop out of the results entirely, where deleting the
 *  whole directory used to reclaim them. */
export const CACHE_SUBDIRS = ['providers', 'plugins', 'modules'] as const;

/** Ceiling on the entries one cache's size walk will stat. A git-sourced module
 *  checkout is a full clone, so `.terraform/modules` routinely holds several
 *  `.git` trees with 100k+ loose objects between them — each one an awaited
 *  lstat on the extension host's libuv threadpool, which is shared with every
 *  other extension in the process. The whole total exists only to render a size
 *  in a notification, so it is not worth an unbounded walk: past the budget the
 *  figure is an undercount, which `formatSize` already tolerates. */
const MAX_SIZE_ENTRIES = 50_000;

/** Bounded and cancellable: this recurses into a module checkout, which for a
 *  git-sourced module is a full clone, and the total exists only to render a
 *  size in a notification. Without the depth cap a pathological tree raises
 *  RangeError, which aborts the whole folder's scan up in the provider. */
async function dirSize(
  dir: string,
  depth = 0,
  cancelled?: () => boolean,
  /** Shared across the subdirectories of one cache, so a huge `modules` cannot
   *  starve `providers` of its own budget — the total is what is capped. */
  budget: { left: number } = { left: MAX_SIZE_ENTRIES },
): Promise<number> {
  if (depth > MAX_DEPTH || budget.left <= 0 || cancelled?.()) return 0;
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const de of entries) {
    if (cancelled?.() || budget.left <= 0) return total;
    const p = join(dir, de.name);
    try {
      // Dirent carries the type, so directories cost no stat; a file still does,
      // since only stat knows its size. isDirectory() is false for a
      // symlink-to-directory exactly as lstat's was, so links stay uncounted
      // and unfollowed.
      if (de.isDirectory()) {
        // the walk that finds caches skips these; the walk that sizes one did
        // not, so a module checkout's own .git was stat'd object by object
        if (SKIP.has(de.name)) continue;
        total += await dirSize(p, depth + 1, cancelled, budget);
      } else {
        budget.left--;
        total += (await lstat(p)).size;
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return total;
}

/** Bytes actually reclaimable from a cache dir: only what the deletion removes.
 *
 *  The lstat is the same rule `dirSize` applies to every entry it walks, which
 *  its own top-level argument escaped: `readdir` follows a symlink, so a
 *  `providers` pointing at a shared plugin cache was summed in full — while the
 *  delete only unlinks the link — and the user was told bytes were freed that
 *  were not. It also dragged an unrelated tree into the scan's I/O. */
async function cacheSize(tfDir: string, cancelled?: () => boolean): Promise<number> {
  let total = 0;
  const budget = { left: MAX_SIZE_ENTRIES };
  for (const sub of CACHE_SUBDIRS) {
    const p = join(tfDir, sub);
    try {
      const st = await lstat(p);
      total += st.isDirectory() ? await dirSize(p, 0, cancelled, budget) : st.size;
    } catch {
      // absent or unreadable — nothing to count
    }
  }
  return total;
}

/** Whether the deletion would actually reclaim anything.
 *
 *  Deliberately separate from `cacheSize`: that total is display-only and is
 *  deliberately bounded (depth cap, unreadable entries swallowed to 0), so
 *  using it to decide *reportability* meant a payload sitting below the cap, or
 *  one that could not be read, silently hid the whole cache from the feature. */
async function hasCachePayload(tfDir: string): Promise<boolean> {
  for (const sub of CACHE_SUBDIRS) {
    const p = join(tfDir, sub);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(p);
    } catch {
      continue; // not there
    }
    // a symlink is unlinked rather than emptied, so it reclaims nothing here
    if (!st.isDirectory()) continue;
    try {
      if ((await readdir(p)).length > 0) return true;
    } catch {
      // unreadable: assume there is something rather than hide the cache
      return true;
    }
  }
  return false;
}

/** Sibling files whose mtime counts as activity. `.json` and `.hcl` matter: a
 *  JSON-syntax module has no `.tf`, and Terragrunt keeps config in
 *  terragrunt.hcl — both would otherwise look abandoned. */
const ACTIVITY_SOURCE = /\.(tf|tfvars)(\.json)?$|\.hcl$/;

/** terraform.tfstate.d/<name>/terraform.tfstate — the dir's own mtime only
 *  moves on workspace create/delete, so an apply is invisible unless the
 *  files inside get stat'd. */
const WORKSPACE_STATE_DIR = 'terraform.tfstate.d';

function isActivityFile(name: string): boolean {
  return (
    ACTIVITY_SOURCE.test(name) ||
    name === '.terraform.lock.hcl' ||
    name.startsWith('terraform.tfstate')
  );
}

/** newest mtime among the .terraform dir, its children, and sibling activity
 *  files — a proxy for "last worked on". */
async function lastActivity(tfDir: string): Promise<number> {
  let newest = 0;
  const consider = async (p: string) => {
    try {
      newest = Math.max(newest, (await lstat(p)).mtimeMs);
    } catch {
      // ignore
    }
  };
  await consider(tfDir);
  try {
    for (const name of await readdir(tfDir)) await consider(join(tfDir, name));
  } catch {
    // ignore
  }
  const moduleDir = join(tfDir, '..');
  try {
    for (const name of await readdir(moduleDir)) {
      if (name === WORKSPACE_STATE_DIR) {
        const wsRoot = join(moduleDir, name);
        try {
          for (const workspace of await readdir(wsRoot)) {
            await consider(join(wsRoot, workspace));
            try {
              for (const state of await readdir(join(wsRoot, workspace))) {
                await consider(join(wsRoot, workspace, state));
              }
            } catch {
              // a plain file where a workspace directory was expected
            }
          }
        } catch {
          // ignore
        }
      } else if (isActivityFile(name)) {
        await consider(join(moduleDir, name));
      }
    }
  } catch {
    // ignore
  }
  return newest;
}

/** .terraform dirs under root whose module shows no activity in staleDays.
 *  Cache only — terraform init recreates it. Symlinks are never followed
 *  (lstat), so the walk can't escape root and a linked .terraform is never
 *  flagged for deletion. */
export async function findStaleTerraformDirs(
  root: string,
  staleDays: number,
  now: number = Date.now(),
  onSkip?: (dir: string) => void,
  /** Checked at every directory. The walk is the long pole in this feature —
   *  `dist`, `build`, `target` and `vendor` are deliberately in scope, so a
   *  monorepo means hundreds of thousands of entries — and without a signal
   *  reaching it, closing the folder left it crawling the disk to completion
   *  for a result nobody would read. The caller's flag only ever gated the
   *  prompt and the deletes, which is after all the work. */
  cancelled?: () => boolean,
): Promise<StaleCache[]> {
  const out: StaleCache[] = [];
  const cutoff = staleCutoff(staleDays, now);
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (cancelled?.()) return;
    if (depth > MAX_DEPTH) {
      onSkip?.(dir);
      return;
    }
    let entries: Dirent[];
    try {
      // withFileTypes: the directory entry already carries its type, and only
      // directories can be (or hold) a .terraform. Asking the kernel again with
      // one awaited lstat per entry — including every regular file, which can
      // never match — cost ~33µs each and made this walk ~6x slower; across a
      // monorepo, where `dist`, `build`, `target` and `vendor` are deliberately
      // in scope, that is tens of seconds of the extension host's libuv
      // threadpool, which is shared with every other extension in the process.
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const de of entries) {
      // a large tree is thousands of iterations between the checks above
      if (cancelled?.()) return;
      // isDirectory() is false for a symlink-to-directory, matching the lstat
      // this replaced, so the walk still cannot escape root and a .terraform
      // that is itself a symlink is still never flagged
      if (!de.isDirectory() || SKIP.has(de.name)) continue;
      const p = join(dir, de.name);
      if (de.name === '.terraform') {
        const last = await lastActivity(p);
        // A cache holding only metadata has nothing to reclaim, and since the
        // deletion now leaves the directory standing, reporting it would mean
        // prompting for the same folders on every single launch. Gated on the
        // payload existing, not on its measured size — see hasCachePayload.
        if (last < cutoff && (await hasCachePayload(p))) {
          out.push({ dir: p, sizeBytes: await cacheSize(p, cancelled), lastActivityMs: last });
        }
        continue; // never descend into .terraform
      }
      await visit(p, depth + 1);
    }
  };
  await visit(root, 0);
  return out;
}

/** The prompt can sit open indefinitely, so a `terraform init` run while
 *  waiting must not get thrown away. */
export async function isStillStale(
  tfDir: string,
  staleDays: number,
  now: number = Date.now(),
): Promise<boolean> {
  return (await lastActivity(tfDir)) < staleCutoff(staleDays, now);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** guard used before any deletion: we only ever remove dirs named .terraform */
export function isTerraformCacheDir(dir: string): boolean {
  return basename(dir) === '.terraform';
}

/** Whether `child` is `parent` or sits underneath it. Both sides must already be
 *  symlink-resolved — this is a string containment test, so a link or a `..` in
 *  either path makes the answer meaningless. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Terraform's platform directories under the pre-0.14 `.terraform/plugins`. */
const LEGACY_PLATFORM_DIR =
  /^(?:darwin|freebsd|linux|openbsd|solaris|windows)_(?:386|amd64|arm|arm64)$/;

/** Terraform 0.12 and earlier documented `.terraform/plugins/<os>_<arch>/` as a
 *  plugin *search path*: an in-house provider with no registry source address
 *  was installed by dropping its binary there by hand, and no `terraform init`
 *  can bring that back — the repo it was built from may not even exist any more.
 *  Those are also exactly the caches old enough to trip a 30-day threshold, so
 *  the feature aims straight at them.
 *
 *  Terraform writes `lock.json` beside the plugins it installed itself, so its
 *  presence is what separates a cache it can rebuild from a hand-built install
 *  it cannot. Absent, we leave the platform directory alone and reclaim nothing:
 *  a few hundred MB of disk is worth less than one irreplaceable binary. The
 *  0.13 nested layout (`plugins/<host>/<ns>/<name>/...`) is unambiguously
 *  registry-managed and stays fully reclaimable. */
async function reclaimablePluginEntries(pluginsDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const de of entries) {
    if (de.isDirectory() && LEGACY_PLATFORM_DIR.test(de.name)) {
      try {
        await lstat(join(pluginsDir, de.name, 'lock.json'));
      } catch {
        continue; // no lock.json: assume hand-placed, keep it
      }
    }
    out.push(de.name);
  }
  return out;
}

/** What `deleteCachePayload` did. A bare `void` made a refusal — including the
 *  symlink guard firing, the one case the guard exists for — indistinguishable
 *  from success at the call site, which then counted the bytes as freed and
 *  logged a clean. */
export type CleanResult = { ok: true } | { ok: false; reason: string };

/** Remove the reclaimable parts of a cache, leaving `.terraform` itself and the
 *  metadata beside it in place. Deleting the directory wholesale also took
 *  `environment` and `terraform.tfstate` with it, which silently reset the
 *  user's selected workspace and lost a `-backend-config` module's settings —
 *  for no space, since the bytes are all in the subdirectories below.
 *
 *  Every path is resolved and proven to land inside `workspaceRoot` first.
 *  `rm` resolves symlinks in *parent* components (verified: an `rm` of
 *  `<root>/mod/.terraform/providers` with `.terraform` a link deletes the
 *  target's `providers` outside the tree), so the name check and the `lstat`
 *  alone left a window — anything replacing `.terraform` with a symlink between
 *  the two, a `direnv` hook or a `make init` doing `rm -rf .terraform && ln -s`,
 *  redirected a recursive delete out of the workspace. Resolving first collapses
 *  that window and makes the escape unrepresentable rather than merely unlikely. */
export async function deleteCachePayload(
  tfDir: string,
  workspaceRoot: string,
): Promise<CleanResult> {
  if (!isAbsolute(tfDir) || !isTerraformCacheDir(tfDir)) {
    return { ok: false, reason: 'not an absolute .terraform path' };
  }
  try {
    // a symlinked .terraform reclaims nothing (rm unlinks the link) while
    // pointing the delete somewhere else entirely, so it is refused outright
    if (!(await lstat(tfDir)).isDirectory()) {
      return { ok: false, reason: 'not a real directory' };
    }
  } catch {
    return { ok: false, reason: 'gone between the scan and the delete' };
  }

  let realDir: string;
  let realRoot: string;
  try {
    realDir = await realpath(tfDir);
    realRoot = await realpath(workspaceRoot);
  } catch {
    return { ok: false, reason: 'gone between the scan and the delete' };
  }
  if (!isTerraformCacheDir(realDir)) {
    return { ok: false, reason: `resolves to ${realDir}, which is not a .terraform dir` };
  }
  if (!isInside(realRoot, realDir)) {
    return { ok: false, reason: `resolves to ${realDir}, outside the workspace` };
  }

  const failures: string[] = [];
  for (const sub of CACHE_SUBDIRS) {
    const target = join(realDir, sub);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(target);
    } catch {
      continue; // a cache with only some of the subdirectories is normal
    }
    // rm unlinks a symlinked subdir rather than following it, so it reclaims
    // nothing and only discards a deliberate shared-mirror setup, which
    // terraform init then replaces with a fresh full download. cacheSize and
    // hasCachePayload already skip these for the same reason.
    if (!st.isDirectory()) continue;

    const names =
      sub === 'plugins' ? await reclaimablePluginEntries(target) : [null as string | null];
    for (const name of names) {
      const victim = name === null ? target : join(target, name);
      try {
        // maxRetries defaults to 0, so the single most common cause of a failed
        // rm -rf — antivirus or the search indexer briefly holding a provider
        // .exe open on Windows — aborted the clean outright. Each subdir is
        // caught on its own too: an unwritable `providers` used to throw
        // straight out of the loop, so `modules` was never even attempted and
        // the half-deleted provider tree left `terraform init` failing with
        // "could not find executable file" instead of re-downloading.
        await rm(victim, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (e) {
        failures.push(`${name === null ? sub : `${sub}/${name}`}: ${e}`);
      }
    }
  }
  return failures.length === 0
    ? { ok: true }
    : { ok: false, reason: `partially cleaned — ${failures.join('; ')}` };
}
