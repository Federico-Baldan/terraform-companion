import { lstat, readdir } from 'node:fs/promises';
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

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = await lstat(p);
      total += st.isDirectory() ? await dirSize(p) : st.size;
    } catch {
      // ignore unreadable entries
    }
  }
  return total;
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
): Promise<StaleCache[]> {
  const out: StaleCache[] = [];
  const cutoff = staleCutoff(staleDays, now);
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      onSkip?.(dir);
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let isDir = false;
      try {
        isDir = (await lstat(p)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir || SKIP.has(name)) continue;
      if (name === '.terraform') {
        const last = await lastActivity(p);
        if (last < cutoff) out.push({ dir: p, sizeBytes: await dirSize(p), lastActivityMs: last });
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
