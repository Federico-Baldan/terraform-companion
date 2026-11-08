import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as semver from 'semver';

// The shared provider cache below is deliberately modelled on what Terraform
// itself does with it (internal/command/cliconfig, internal/providercache):
// it links a cached provider into a project with a symlink and never writes to
// the cache entry again, and it never deletes anything from the cache itself.

export interface StaleCache {
  dir: string;
  sizeBytes: number;
  lastActivityMs: number;
  /** Exactly what a clean would remove, relative to `dir` — `providers`,
   *  `modules`, `plugins/<entry>`. Carried on the scan result so the prompt can
   *  name the directories instead of asking for a blanket yes to a number. */
  entries: string[];
}

export interface ProviderCacheEntry {
  dir: string;
  source: string;
  sizeBytes: number;
  lastActivityMs: number;
}

/** A `provider "source" {` block that starts its line.
 *
 *  The indent is blanks within the line, not `\s*`: that also crosses newlines, so
 *  on a run of blank lines it walked the whole run from every line start, found no
 *  `provider` at the end of it, and began again one line later — quadratic, and a
 *  lock file of 40k blank lines followed by anything else cost 2s (4s with a space
 *  on each line). Every line start is still a candidate, so the same blocks match;
 *  only the walk across other lines is gone. The class is `\s` minus the four
 *  characters `^` treats as a line break. */
const LOCK_PROVIDER = /^[^\S\n\r\u2028\u2029]*provider\s+"([^"]+)"\s*\{/gm;
/** `key = "value"`, the key bare or quoted as HCL allows. Sticky, so it matches
 *  at exactly the position it is given. */
const STRING_ASSIGNMENT = /"?([A-Za-z_][\w-]*)"?[ \t]*=[ \t]*"([^"\r\n]*)"/y;
/** `name {` or `name "label" {`: the start of a block. */
const BLOCK_OPEN = /"?([A-Za-z_][\w-]*)"?(?:[ \t]+"[^"\r\n]*")*[ \t]*\{/y;

/** Provider sources named by lock files. A lock file identifies a provider
 * source, not a single version, so protecting the whole source is the only
 * safe operation without guessing from constraints or checksums. */
export function providerSourcesFromLockFile(contents: string): Set<string> {
  return new Set(
    [...contents.matchAll(LOCK_PROVIDER)]
      .map((match) => match[1])
      .filter((source): source is string => Boolean(source)),
  );
}

interface StringAssignment {
  /** the names of the blocks it sits in, outermost first */
  blocks: readonly string[];
  key: string;
  value: string;
}

/** Every `key = "string"` of a Terraform CLI config, with the blocks around it.
 *  Terraform parses that file as HCL, where an assignment only means something
 *  in the block it is in, and a comment (`#`, `//`, `/* *​/`) says nothing. A
 *  pattern on the raw text could not tell `provider_installation {
 *  plugin_cache_dir = ... }` or a commented-out line from the real thing, so the
 *  text is walked instead: comments and strings are skipped, blocks are named as
 *  they open and close, and an assignment is read only where a statement starts,
 *  which is a new line or the `{` of a block (`filesystem_mirror { path = "/x" }`
 *  is one line). */
function stringAssignmentsOf(text: string): StringAssignment[] {
  const found: StringAssignment[] = [];
  const blocks: string[] = [];
  let statementStart = true;
  for (let i = 0; i < text.length; ) {
    const c = text.charAt(i);
    if (c === '\n') {
      statementStart = true;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++;
    } else if (c === '#' || (c === '/' && text.charAt(i + 1) === '/')) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (c === '/' && text.charAt(i + 1) === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      if (statementStart) {
        BLOCK_OPEN.lastIndex = i;
        const open = BLOCK_OPEN.exec(text);
        if (open?.[1]) {
          blocks.push(open[1]);
          i = BLOCK_OPEN.lastIndex;
          continue;
        }
        STRING_ASSIGNMENT.lastIndex = i;
        const assignment = STRING_ASSIGNMENT.exec(text);
        if (assignment?.[1] !== undefined && assignment[2] !== undefined)
          found.push({ blocks: [...blocks], key: assignment[1], value: assignment[2] });
      }
      statementStart = c === '{';
      if (c === '"') {
        i++;
        while (i < text.length && text.charAt(i) !== '"' && text.charAt(i) !== '\n')
          i += text.charAt(i) === '\\' ? 2 : 1;
        i++;
      } else {
        if (c === '{') blocks.push('');
        else if (c === '}') blocks.pop();
        i++;
      }
    }
  }
  return found;
}

/** The top-level `plugin_cache_dir` of a Terraform CLI config. */
export function pluginCacheDirOf(text: string): string | undefined {
  return stringAssignmentsOf(text).find(
    (a) => a.blocks.length === 0 && a.key === 'plugin_cache_dir' && a.value !== '',
  )?.value;
}

/** The `path` of every `filesystem_mirror` block of a Terraform CLI config. */
export function filesystemMirrorPathsOf(text: string): string[] {
  return stringAssignmentsOf(text)
    .filter(
      (a) =>
        a.key === 'path' &&
        a.blocks.length === 2 &&
        a.blocks[0] === 'provider_installation' &&
        a.blocks[1] === 'filesystem_mirror' &&
        a.value !== '',
    )
    .map((a) => a.value);
}

/** Whether `path` is absolute on `os`. On Windows a rooted path with no drive,
 *  such as `/x` — what `$HOME/x` becomes when `HOME` is unset, the usual case
 *  there — passes `path.isAbsolute` yet resolves against the current drive. */
export function isAbsoluteFsPath(path: string, os: NodeJS.Platform = platform()): boolean {
  return os === 'win32' ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(path) : isAbsolute(path);
}

/** `~/.terraform.d/plugins` and its siblings are Terraform's implied local
 *  provider mirrors: the layout of a plugin cache, but holding providers placed
 *  by hand, which nothing can restore. HashiCorp's docs say the cache directory
 *  must not be one, and a sweep that took it for one would delete them. */
const LOCAL_MIRROR_DIR =
  /(?:^|[\\/])(?:\.?terraform\.d|terraform|io\.terraform)[\\/]plugins[\\/]*$/i;

/** Go's `os.ExpandEnv`, which Terraform applies to the `plugin_cache_dir` value
 *  of the CLI config file — so `$HOME/.terraform.d/plugin-cache`, the example in
 *  HashiCorp's own docs, names a real directory. An unset variable expands to
 *  nothing, as it does there. Terraform does not expand `~`, and neither do we. */
export function expandEnv(value: string): string {
  return value.replace(
    /\$(?:\{(\w+)\}|(\w+))/g,
    (_match, braced?: string, bare?: string) => process.env[braced ?? bare ?? ''] ?? '',
  );
}

/** The CLI config files Terraform reads, in the order it prefers them
 *  (internal/command/cliconfig): one named by `TF_CLI_CONFIG_FILE`, else
 *  `TERRAFORM_CONFIG`, and nothing else; otherwise `~/.terraformrc` (on Windows
 *  `%APPDATA%\\terraform.rc`) and then the `*.tfrc` files in `~/.terraform.d`
 *  (`%APPDATA%\\terraform.d`), `*.tfrc.json` ones included, in file name order. */
async function cliConfigFiles(): Promise<string[]> {
  const override = process.env.TF_CLI_CONFIG_FILE || process.env.TERRAFORM_CONFIG;
  if (override) return [override];
  const win = platform() === 'win32';
  const base = win ? (process.env.APPDATA ?? homedir()) : homedir();
  const dir = join(base, win ? 'terraform.d' : '.terraform.d');
  let names: string[] = [];
  try {
    names = (await readdir(dir))
      .filter((name) => name.endsWith('.tfrc') || name.endsWith('.tfrc.json'))
      .sort();
  } catch {
    // no config directory is normal
  }
  return [
    join(base, win ? 'terraform.rc' : '.terraformrc'),
    ...names.map((name) => join(dir, name)),
  ];
}

/** The `path` of every `filesystem_mirror` of a `*.tfrc.json` CLI config. HCL's
 *  JSON syntax lets a block be an object or an array of them, at both levels. */
function filesystemMirrorPathsOfJson(text: string): string[] {
  const objects = (value: unknown): Record<string, unknown>[] =>
    (Array.isArray(value) ? value : [value]).filter(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
    );
  const paths: string[] = [];
  const root = objects(JSON.parse(text) as unknown);
  for (const config of root)
    for (const installation of objects(config.provider_installation))
      for (const mirror of objects(installation.filesystem_mirror))
        if (typeof mirror.path === 'string' && mirror.path !== '') paths.push(mirror.path);
  return paths;
}

/** Every `filesystem_mirror` path of every CLI config file, not only the one that
 *  names the cache: Terraform appends the `provider_installation` blocks of all of
 *  them, and the cache may come from `TF_PLUGIN_CACHE_DIR`. Taken as written,
 *  since Terraform neither expands nor checks it. */
async function filesystemMirrorPaths(log?: (m: string) => void): Promise<string[]> {
  const paths: string[] = [];
  for (const candidate of await cliConfigFiles()) {
    try {
      const text = await readFile(candidate, 'utf8');
      paths.push(
        ...(isJsonConfig(text) ? filesystemMirrorPathsOfJson(text) : filesystemMirrorPathsOf(text)),
      );
    } catch (e) {
      skippedConfig(candidate, e, log);
    }
  }
  return paths;
}

/** HCL v1 takes a file for JSON when its first non-blank character is `{`,
 *  whatever the file is called. */
function isJsonConfig(text: string): boolean {
  return text.trimStart().startsWith('{');
}

/** An absent CLI config is normal. One that is there and could not be read or
 *  parsed is skipped, which Terraform itself would not do, so it is said. */
function skippedConfig(file: string, error: unknown, log?: (m: string) => void): void {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
  log?.(`cacheCleaner: CLI config ${file} skipped: ${error}`);
}

/** Whether two paths are one directory: through links, trailing separators and,
 *  where the file system ignores case, case. A path that does not exist is
 *  compared as written. */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  const canonical = async (path: string): Promise<string> => {
    let real = resolve(path);
    try {
      real = await realpath(path);
    } catch {
      // not there: the written path is all there is to compare
    }
    return platform() === 'win32' ? real.toLowerCase() : real;
  };
  return (await canonical(a)) === (await canonical(b));
}

/** The `plugin_cache_dir` of a `*.tfrc.json` CLI config, which Terraform reads
 *  as JSON. */
function pluginCacheDirOfJson(text: string): string | undefined {
  const value: unknown = (JSON.parse(text) as { plugin_cache_dir?: unknown } | null)
    ?.plugin_cache_dir;
  return typeof value === 'string' && value ? value : undefined;
}

/** Where Terraform keeps its shared plugin cache, or nothing when none is
 *  configured. Resolved the way Terraform resolves it: `TF_PLUGIN_CACHE_DIR`
 *  wins and is used verbatim, otherwise the first CLI config file that sets it,
 *  after `$VAR` expansion. A relative path is refused: Terraform resolves it
 *  against its own working directory, which the extension host cannot know, so
 *  any guess could point the scan at the wrong tree. So is a local provider
 *  mirror (see `LOCAL_MIRROR_DIR`), by the name it was given and by where it
 *  really is. Each refusal is logged, so a cache that is never swept can be told
 *  apart from one that is not configured. */
export async function configuredProviderCache(
  log?: (m: string) => void,
): Promise<string | undefined> {
  const usable = async (dir: string): Promise<string | undefined> => {
    if (!isAbsoluteFsPath(dir)) {
      log?.(`cacheCleaner: shared plugin cache ${dir} ignored, the path must be absolute`);
      return undefined;
    }
    let real = dir;
    try {
      real = await realpath(dir);
    } catch {
      // not there yet: only the name can be judged
    }
    if (LOCAL_MIRROR_DIR.test(dir) || LOCAL_MIRROR_DIR.test(real)) {
      log?.(`cacheCleaner: shared plugin cache ${dir} ignored, it is a local provider mirror`);
      return undefined;
    }
    // a mirror declared in the CLI config: Terraform says the cache must not be one
    for (const mirror of await filesystemMirrorPaths(log)) {
      if (!isAbsoluteFsPath(mirror)) {
        // Terraform resolves it against its own working directory, which could
        // make it this very directory, and nothing here can tell
        log?.(
          `cacheCleaner: shared plugin cache ${dir} ignored, filesystem_mirror path ${mirror} is relative so it cannot be told apart from the cache`,
        );
        return undefined;
      }
      if (await sameDirectory(dir, mirror)) {
        log?.(
          `cacheCleaner: shared plugin cache ${dir} ignored, the CLI config names it as a filesystem_mirror, which holds providers placed by hand`,
        );
        return undefined;
      }
    }
    return dir;
  };
  const fromEnv = process.env.TF_PLUGIN_CACHE_DIR;
  if (fromEnv) return usable(fromEnv);
  for (const candidate of await cliConfigFiles()) {
    try {
      const text = await readFile(candidate, 'utf8');
      const configured = isJsonConfig(text) ? pluginCacheDirOfJson(text) : pluginCacheDirOf(text);
      if (configured) return usable(expandEnv(configured));
    } catch (e) {
      skippedConfig(candidate, e, log);
    }
  }
  return undefined;
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

/** Entries the lock-file walk may read in one workspace folder. It follows
 *  symlinks, so a link to `/usr` would otherwise cost every scan, and the second
 *  one after the prompt, half a minute. Past the budget the scan reports itself
 *  incomplete, which switches the shared-cache sweep off. */
export const MAX_LOCK_WALK_ENTRIES = 200_000;

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

/** What a clean would remove from `tfDir`, and whether any of it is worth
 *  removing.
 *
 *  `entries` is the list the prompt shows, so it has to be exactly what
 *  `deleteCachePayload` will target — same subdirectories, same symlink skip,
 *  same `plugins` lock.json rule — or the user approves one thing and gets
 *  another.
 *
 *  `hasPayload` is deliberately *not* derived from `cacheSize`: that total is
 *  display-only and bounded (depth cap, unreadable entries swallowed to 0), so
 *  using it to decide reportability meant a payload sitting below the cap, or
 *  one that could not be read, silently hid the whole cache from the feature.
 *  It is also not `entries.length > 0`: the delete leaves `.terraform`
 *  standing, so a cache of empty directories would be offered again on every
 *  single launch, forever. */
export async function cacheTargets(
  tfDir: string,
): Promise<{ entries: string[]; hasPayload: boolean }> {
  const entries: string[] = [];
  let hasPayload = false;
  for (const sub of CACHE_SUBDIRS) {
    const p = join(tfDir, sub);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(p);
    } catch {
      continue; // not there
    }
    // a symlink is unlinked rather than emptied, so it reclaims nothing and the
    // delete skips it — it must not be listed as something we will remove
    if (!st.isDirectory()) continue;
    // `plugins` has to ask the same question the delete will. A legacy
    // `plugins/<os>_<arch>/` with no lock.json is deliberately kept by
    // `reclaimablePluginEntries`, but a plain readdir counted it as payload —
    // so a cache nothing would ever reclaim was reported stale, "cleaned",
    // counted as freed bytes, and (its mtime never moving) offered again on
    // every window open, forever.
    if (sub === 'plugins') {
      for (const name of await reclaimablePluginEntries(p)) {
        entries.push(`${sub}/${name}`);
        hasPayload = true;
      }
      continue;
    }
    entries.push(sub);
    try {
      if ((await readdir(p)).length > 0) hasPayload = true;
    } catch {
      // unreadable: assume there is something rather than hide the cache
      hasPayload = true;
    }
  }
  return { entries, hasPayload };
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
        if (last < cutoff) {
          // A cache holding only metadata has nothing to reclaim, and since the
          // deletion now leaves the directory standing, reporting it would mean
          // prompting for the same folders on every single launch. Gated on the
          // payload existing, not on its measured size — see cacheTargets.
          const { entries: victims, hasPayload } = await cacheTargets(p);
          if (hasPayload) {
            out.push({
              dir: p,
              sizeBytes: await cacheSize(p, cancelled),
              lastActivityMs: last,
              entries: victims,
            });
          }
        }
        continue; // never descend into .terraform
      }
      await visit(p, depth + 1);
    }
  };
  await visit(root, 0);
  return out;
}

export interface ProviderSourceScan {
  sources: Set<string>;
  /** False when anything that could name a provider went unread: a directory
   *  that would not list, a lock file that would not open, the depth limit, or a
   *  cancelled walk. The sources are what *protects* cache entries, so an
   *  incomplete set means "unprotected" for exactly the providers a missed lock
   *  file would have named — the caller must not delete on it. */
  complete: boolean;
  /** True when the walk stopped because the workspace holds more entries than
   *  `MAX_LOCK_WALK_ENTRIES`. `complete` is false then too; this says why. */
  limited: boolean;
}

/** `SKIP` minus `.terragrunt-cache`. The sweep for stale `.terraform` folders
 *  skips it because its mtimes belong to the checkout; a *lock file* there is the
 *  opposite case, a real project that really links providers from the cache. */
const LOCK_SKIP = new Set([...SKIP].filter((name) => name !== '.terragrunt-cache'));

/** `<host>/<namespace>/<type>` of each provider an initialised project has under
 *  `.terraform/providers`. That is what the project links from the cache, whether
 *  or not its lock file exists or was found. */
async function providerSourcesFromDotTerraform(
  tfDir: string,
): Promise<{ sources: string[]; complete: boolean }> {
  const sources: string[] = [];
  let complete = true;
  const dirs = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') complete = false;
      return [];
    }
  };
  const base = join(tfDir, 'providers');
  for (const host of await dirs(base))
    for (const namespace of await dirs(join(base, host)))
      for (const type of await dirs(join(base, host, namespace)))
        sources.push(`${host}/${namespace}/${type}`);
  return { sources, complete };
}

/** Collects the provider sources a workspace folder still needs: those named by
 * a lock file, and those an initialised project links under `.terraform`.
 * Sources, rather than versions, are protected because Terraform lock files do
 * not record a standalone selected-version field.
 *
 * Everything that could hide a project is followed or counted against
 * `complete`: a symlinked `.terraform.lock.hcl` (monorepos share one that way;
 * `Dirent.isFile()` is false for a link), a symlinked directory (guarded by the
 * real path, so a loop ends), and `.terragrunt-cache`. */
export async function collectProviderSources(
  root: string,
  cancelled?: () => boolean,
  maxEntries: number = MAX_LOCK_WALK_ENTRIES,
): Promise<ProviderSourceScan> {
  const sources = new Set<string>();
  let complete = true;
  let limited = false;
  let left = maxEntries;
  const seen = new Set<string>();
  const visit = async (dir: string, real: string, depth: number): Promise<void> => {
    if (cancelled?.()) {
      complete = false;
      return;
    }
    // out of budget: `complete` is already false, and reading on would only cost time
    if (depth > MAX_DEPTH || left < 0) {
      complete = false;
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    // a link may lead anywhere, so a tree has to be bounded by what it holds
    left -= entries.length;
    if (left < 0) {
      complete = false;
      limited = true;
      return;
    }
    for (const de of entries) {
      if (cancelled?.()) {
        complete = false;
        return;
      }
      const path = join(dir, de.name);
      if (de.name === '.terraform.lock.hcl' && (de.isFile() || de.isSymbolicLink())) {
        try {
          for (const source of providerSourcesFromLockFile(await readFile(path, 'utf8')))
            sources.add(source);
        } catch {
          // Gone mid-walk, or a dangling link: either way this project's providers
          // are unknown, which is not the same as "uses none".
          complete = false;
        }
      } else if (de.isDirectory()) {
        if (LOCK_SKIP.has(de.name)) continue;
        // what the project links in is already read from the directory names; the
        // links themselves lead into the shared cache, which is no place to walk
        // `modules` holds what the project downloaded: somebody else's code, whose
        // lock files Terraform never reads, and the bulk of a terragrunt tree
        if ((de.name === 'providers' || de.name === 'modules') && basename(dir) === '.terraform')
          continue;
        if (de.name === '.terraform') {
          const linked = await providerSourcesFromDotTerraform(path);
          for (const source of linked.sources) sources.add(source);
          if (!linked.complete) complete = false;
        }
        await visit(path, join(real, de.name), depth + 1);
      } else if (de.isSymbolicLink() && !LOCK_SKIP.has(de.name)) {
        let target: string;
        try {
          if (!(await stat(path)).isDirectory()) continue;
          target = await realpath(path);
        } catch (e) {
          // a link to nothing, or in a loop, has no lock file to find; one that
          // could not be reached (permissions, a stale mount) may have had one
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ELOOP' && code !== 'ENOTDIR') complete = false;
          continue;
        }
        if (de.name === '.terraform') {
          const linked = await providerSourcesFromDotTerraform(path);
          for (const source of linked.sources) sources.add(source);
          if (!linked.complete) complete = false;
        }
        await visit(path, target, depth + 1);
      }
    }
  };
  let rootReal = root;
  try {
    rootReal = await realpath(root);
  } catch {
    complete = false;
  }
  await visit(root, rootReal, 0);
  return { sources, complete, limited };
}

/** Newest mtime among the descendants of `dir` (not `dir` itself), with the
 *  same bounds, and the same refusal to follow links, as `dirSize`. */
async function newestBelow(
  dir: string,
  depth = 0,
  cancelled?: () => boolean,
  budget: { left: number } = { left: MAX_SIZE_ENTRIES },
): Promise<number> {
  if (depth > MAX_DEPTH || budget.left <= 0 || cancelled?.()) return 0;
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const de of entries) {
    if (cancelled?.() || budget.left <= 0) return newest;
    const p = join(dir, de.name);
    try {
      budget.left--;
      newest = Math.max(newest, (await lstat(p)).mtimeMs);
      if (de.isDirectory())
        newest = Math.max(newest, await newestBelow(p, depth + 1, cancelled, budget));
    } catch {
      // unreadable entry: it says nothing about activity
    }
  }
  return newest;
}

/** Last sign of life of a provider version directory. Terraform links a cached
 *  provider into a project and never writes to the cache entry again, so the
 *  directory's own mtime is when it was installed — a provider used every day
 *  still looks months old by that measure. Anything written beneath it (an
 *  install finishing, a binary being replaced) is the only activity there is to
 *  see, which is why it is counted. */
async function providerActivity(
  dir: string,
  ownMtimeMs: number,
  cancelled?: () => boolean,
): Promise<number> {
  return Math.max(ownMtimeMs, await newestBelow(dir, 0, cancelled));
}

/** A registry host: a name with a dot, or `localhost`. */
const REGISTRY_HOST = /^(?:[^\\/\s]+\.[^\\/\s]+|localhost)$/i;
const OS_ARCH_DIR = /^[a-z0-9]+_[a-z0-9]+$/i;

/** Whether `versionDir` is what `terraform init` leaves: a semantic version with
 *  an `<os>_<arch>` directory inside. Terraform checks only that
 *  `plugin_cache_dir` exists, so without this any tree four levels deep is
 *  "a provider". */
async function isInstalledProvider(versionDir: string, versionName: string): Promise<boolean> {
  if (semver.valid(versionName) === null) return false;
  try {
    return (await readdir(versionDir, { withFileTypes: true })).some(
      (d) => d.isDirectory() && OS_ARCH_DIR.test(d.name),
    );
  } catch {
    return false;
  }
}

export async function findStaleProviderCacheEntries(
  cacheRoot: string,
  protectedSources: ReadonlySet<string>,
  staleDays: number,
  now: number = Date.now(),
  cancelled?: () => boolean,
): Promise<ProviderCacheEntry[]> {
  const out: ProviderCacheEntry[] = [];
  const cutoff = staleCutoff(staleDays, now);
  let hosts: Dirent[];
  try {
    hosts = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const host of hosts) {
    if (cancelled?.() || !host.isDirectory() || !REGISTRY_HOST.test(host.name)) continue;
    let namespaces: Dirent[];
    try {
      namespaces = await readdir(join(cacheRoot, host.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const namespace of namespaces) {
      if (cancelled?.() || !namespace.isDirectory()) continue;
      let providers: Dirent[];
      try {
        providers = await readdir(join(cacheRoot, host.name, namespace.name), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const provider of providers) {
        if (cancelled?.() || !provider.isDirectory()) continue;
        const source = `${host.name}/${namespace.name}/${provider.name}`;
        if (protectedSources.has(source)) continue;
        const providerDir = join(cacheRoot, host.name, namespace.name, provider.name);
        let versions: Dirent[];
        try {
          versions = await readdir(providerDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const version of versions) {
          if (cancelled?.() || !version.isDirectory()) continue;
          const dir = join(providerDir, version.name);
          if (!(await isInstalledProvider(dir, version.name))) continue;
          let st: Awaited<ReturnType<typeof lstat>>;
          try {
            st = await lstat(dir);
          } catch {
            continue;
          }
          const activity = await providerActivity(dir, st.mtimeMs, cancelled);
          if (activity >= cutoff) continue;
          out.push({
            dir,
            source,
            sizeBytes: await dirSize(dir, 0, cancelled),
            lastActivityMs: activity,
          });
        }
      }
    }
  }
  return out;
}

export async function deleteProviderCacheEntry(
  entry: ProviderCacheEntry,
  cacheRoot: string,
): Promise<CleanResult> {
  try {
    const realRoot = await realpath(cacheRoot);
    const realEntry = await realpath(entry.dir);
    // The scan found this entry at <root>/<relative>. Anywhere else it now
    // resolves to means a level was swapped for a link since: the prompt can sit
    // open for hours, and being inside the root is not enough, since the other
    // end of the link may be an entry the user never saw, or one a lock file names.
    const expected = join(realRoot, relative(cacheRoot, entry.dir));
    if (realEntry === realRoot || realEntry !== expected || !isInside(realRoot, realEntry)) {
      return { ok: false, reason: 'provider cache path is not where the scan found it' };
    }
    if (!(await lstat(entry.dir)).isDirectory()) return { ok: false, reason: 'not a directory' };
    await rm(realEntry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { ok: true, removed: [entry.dir] };
  } catch (e) {
    return { ok: false, reason: `${e}` };
  }
}

/** The provider-cache counterpart of `isStillStale`: the prompt can sit open
 *  indefinitely, and the shared cache is exactly where a `terraform init` in
 *  another project writes while it waits. A directory that is gone counts as
 *  not stale, since there is nothing left to delete. */
export async function isProviderEntryStillStale(
  dir: string,
  staleDays: number,
  now: number = Date.now(),
): Promise<boolean> {
  let own: number;
  try {
    own = (await lstat(dir)).mtimeMs;
  } catch {
    return false;
  }
  return (await providerActivity(dir, own)) < staleCutoff(staleDays, now);
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
 *  logged a clean.
 *
 *  `removed` names the entries rather than counting them, so the log and the
 *  report say which directories actually went. */
export type CleanResult = { ok: true; removed: string[] } | { ok: false; reason: string };

/** Remove the reclaimable parts of a cache, leaving `.terraform` itself and the
 *  metadata beside it in place. Deleting the directory wholesale also took
 *  `environment` and `terraform.tfstate` with it, which silently reset the
 *  user's selected workspace and lost a `-backend-config` module's settings —
 *  for no space, since the bytes are all in the subdirectories below.
 *
 *  Every path is resolved and proven to land inside `workspaceRoot`, and then
 *  re-proven immediately before each individual `rm`.
 *
 *  `rm` resolves symlinks in *parent* components (verified: an `rm` of
 *  `<root>/mod/.terraform/providers` with `.terraform` a link deletes the
 *  target's `providers` outside the tree), so the name check and the `lstat`
 *  alone left a window — anything replacing `.terraform` with a symlink between
 *  the two, a `direnv` hook or a `make init` doing `rm -rf .terraform && ln -s`,
 *  redirected a recursive delete out of the workspace.
 *
 *  Proving containment once was not enough either: `realDir` is a path *string*,
 *  not a handle, and this issues up to three independent removals. A swap
 *  landing between two of them redirected every remaining delete — and the
 *  function still reported success, so the caller logged a clean and counted the
 *  bytes as freed. Node exposes no handle-relative remove, so the window cannot
 *  be closed outright; re-proving per victim narrows it to one syscall pair and
 *  turns the swap into a refusal instead of an escape. */
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
  const removed: string[] = [];

  /** Re-prove one victim right before it is removed. `'gone'` is the ordinary
   *  race (already deleted, never existed); `'escaped'` means the path now
   *  resolves somewhere it must never be removed from, which is a refusal the
   *  caller has to hear about rather than a silent skip. */
  const prove = async (victim: string): Promise<{ real: string } | 'gone' | 'escaped'> => {
    let real: string;
    try {
      real = await realpath(victim);
    } catch {
      return 'gone';
    }
    if (!isInside(realRoot, real)) return 'escaped';
    // still under a .terraform, and still under the one we vetted: a swap that
    // keeps the path inside the workspace is still not ours to delete
    if (!isInside(realDir, real)) return 'escaped';
    return { real };
  };

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
      const label = name === null ? sub : `${sub}/${name}`;
      const proof = await prove(victim);
      if (proof === 'gone') continue;
      if (proof === 'escaped') {
        failures.push(`${label}: no longer resolves inside the cache — refused`);
        continue;
      }
      try {
        // maxRetries defaults to 0, so the single most common cause of a failed
        // rm -rf — antivirus or the search indexer briefly holding a provider
        // .exe open on Windows — aborted the clean outright. Each subdir is
        // caught on its own too: an unwritable `providers` used to throw
        // straight out of the loop, so `modules` was never even attempted and
        // the half-deleted provider tree left `terraform init` failing with
        // "could not find executable file" instead of re-downloading.
        // the re-proved path, not the one built from the snapshot
        await rm(proof.real, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        removed.push(label);
      } catch (e) {
        failures.push(`${label}: ${e}`);
      }
    }
  }
  return failures.length === 0
    ? { ok: true, removed }
    : { ok: false, reason: `partially cleaned — ${failures.join('; ')}` };
}
