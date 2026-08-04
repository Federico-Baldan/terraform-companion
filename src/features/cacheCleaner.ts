import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

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

/** Bounded and cancellable: this recurses into a module checkout, which for a
 *  git-sourced module is a full clone (its .git and every loose object with it),
 *  and the total exists only to render a size in a notification. Without the
 *  depth cap a pathological tree raises RangeError, which aborts the whole
 *  folder's scan up in the provider. */
async function dirSize(dir: string, depth = 0, cancelled?: () => boolean): Promise<number> {
  if (depth > MAX_DEPTH || cancelled?.()) return 0;
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const de of entries) {
    if (cancelled?.()) return total;
    const p = join(dir, de.name);
    try {
      // Dirent carries the type, so directories cost no stat; a file still does,
      // since only stat knows its size. isDirectory() is false for a
      // symlink-to-directory exactly as lstat's was, so links stay uncounted
      // and unfollowed.
      total += de.isDirectory() ? await dirSize(p, depth + 1, cancelled) : (await lstat(p)).size;
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
  for (const sub of CACHE_SUBDIRS) {
    const p = join(tfDir, sub);
    try {
      const st = await lstat(p);
      total += st.isDirectory() ? await dirSize(p, 0, cancelled) : st.size;
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

/** Remove the reclaimable parts of a cache, leaving `.terraform` itself and the
 *  metadata beside it in place. Deleting the directory wholesale also took
 *  `environment` and `terraform.tfstate` with it, which silently reset the
 *  user's selected workspace and lost a `-backend-config` module's settings —
 *  for no space, since the bytes are all in the two subdirectories below.
 *
 *  Refuses anything not named `.terraform`, and anything that is not a real
 *  directory. That second guard is load-bearing: deleting `.terraform` itself
 *  only ever unlinked a symlink, but descending to `.terraform/providers`
 *  resolves *through* the link, so a linked cache would have had the real
 *  directory on the other side emptied — outside the workspace. A name check
 *  alone cannot establish that, since the name is all a symlink shares. */
export async function deleteCachePayload(tfDir: string): Promise<void> {
  if (!isTerraformCacheDir(tfDir)) return;
  try {
    if (!(await lstat(tfDir)).isDirectory()) return;
  } catch {
    return; // gone between the scan and here
  }
  for (const sub of CACHE_SUBDIRS) {
    // force: a cache with only some of the subdirectories is normal. A symlink
    // *inside* a real .terraform is unlinked by rm, not followed, so it needs
    // no guard of its own.
    await rm(join(tfDir, sub), { recursive: true, force: true });
  }
}
