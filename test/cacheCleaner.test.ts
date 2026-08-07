import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCachePayload,
  findStaleTerraformDirs,
  formatSize,
  isStillStale,
  isTerraformCacheDir,
} from '../src/features/cacheCleaner';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 16);

function touch(path: string, ageDays: number): void {
  const t = new Date(NOW - ageDays * DAY);
  utimesSync(path, t, t);
}

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tfc-cache-'));
  outside = mkdtempSync(join(tmpdir(), 'tfc-outside-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function makeModule(base: string, name: string, cacheAgeDays: number, tfAgeDays: number): string {
  const mod = join(base, name);
  const cache = join(mod, '.terraform');
  mkdirSync(join(cache, 'providers'), { recursive: true });
  writeFileSync(join(cache, 'providers', 'bin'), 'x'.repeat(2048));
  writeFileSync(join(mod, 'main.tf'), 'resource "a" "b" {}');
  touch(join(cache, 'providers', 'bin'), cacheAgeDays);
  touch(join(cache, 'providers'), cacheAgeDays);
  touch(join(mod, 'main.tf'), tfAgeDays);
  touch(cache, cacheAgeDays);
  return cache;
}

describe('cache cleaner', () => {
  it('finds .terraform dirs with no recent activity', async () => {
    const old = makeModule(root, 'old', 60, 60);
    makeModule(root, 'fresh', 60, 2); // recently edited .tf → not stale
    const stale = await findStaleTerraformDirs(root, 30, NOW);
    expect(stale.map((s) => s.dir)).toEqual([old]);
    expect(stale[0]!.sizeBytes).toBeGreaterThan(2000);
  });

  it('counts JSON-syntax sources as activity', async () => {
    const cache = makeModule(root, 'json', 60, 60);
    const mod = join(cache, '..');
    // a module written in Terraform's JSON syntax has no .tf file at all
    for (const name of ['main.tf.json', 'vars.tfvars.json']) {
      writeFileSync(join(mod, name), '{}');
      touch(join(mod, name), 2);
    }
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  /** A Terragrunt unit has no .tf file of its own — the module lives
   *  elsewhere and terragrunt.hcl is what actually gets edited. Ignoring .hcl
   *  made every actively-maintained unit look abandoned. */
  it('counts .hcl config (terragrunt) as activity', async () => {
    const cache = makeModule(root, 'terragrunt', 60, 60);
    const mod = join(cache, '..');
    writeFileSync(join(mod, 'terragrunt.hcl'), 'terraform { source = "../../mod" }\n');
    touch(join(mod, 'terragrunt.hcl'), 2);
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  /** Terragrunt's scratch tree holds checked-out copies of modules, each with
   *  a nested .terraform. Their mtimes belong to the checkout, not the user's
   *  work, so the staleness heuristic says nothing there. */
  it('does not report caches inside .terragrunt-cache', async () => {
    const buried = join(root, 'unit', '.terragrunt-cache', 'abc123', 'mod');
    mkdirSync(join(buried, '.terraform'), { recursive: true });
    writeFileSync(join(buried, 'main.tf'), '');
    touch(join(buried, 'main.tf'), 60);
    touch(join(buried, '.terraform'), 60);
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  it('re-checks staleness right before deletion', async () => {
    const cache = makeModule(root, 'raced', 60, 60);
    expect(await isStillStale(cache, 30, NOW)).toBe(true);
    // a terraform init between the scan and the confirmation prompt
    touch(cache, 0);
    expect(await isStillStale(cache, 30, NOW)).toBe(false);
  });

  // a cutoff at or after "now" matches every cache, including one built
  // seconds ago; with autoDelete on, nothing prompts first. VS Code doesn't
  // enforce package.json's minimum, so these values do reach the scanner
  describe('staleDays floor', () => {
    // minutes old, not exactly NOW — a real workspace never has an mtime
    // equal to the current instant, and an exactly-NOW fixture would pass
    // even unfixed (last < cutoff is false on equality)
    const MINUTES = 0.01; // ~14 minutes, in days

    it('does not sweep an actively used module when staleDays is 0', async () => {
      makeModule(root, 'active', MINUTES, MINUTES);
      expect(await findStaleTerraformDirs(root, 0, NOW)).toEqual([]);
    });

    it('does not sweep an actively used module when staleDays is negative', async () => {
      makeModule(root, 'active', MINUTES, MINUTES);
      expect(await findStaleTerraformDirs(root, -30, NOW)).toEqual([]);
    });

    it('falls back to the shipped default when staleDays is not a number', async () => {
      const old = makeModule(root, 'old', 60, 60);
      makeModule(root, 'recent', 10, 10); // inside the 30-day default
      const found = await findStaleTerraformDirs(root, Number.NaN, NOW);
      expect(found.map((s) => s.dir)).toEqual([old]);
    });

    it('still honours a one-day floor for genuinely abandoned modules', async () => {
      const old = makeModule(root, 'old', 60, 60);
      makeModule(root, 'today', MINUTES, MINUTES);
      const found = await findStaleTerraformDirs(root, 0, NOW);
      expect(found.map((s) => s.dir)).toEqual([old]);
    });

    it('applies the same floor to the pre-deletion re-check', async () => {
      const cache = makeModule(root, 'active', MINUTES, MINUTES);
      expect(await isStillStale(cache, 0, NOW)).toBe(false);
      expect(await isStillStale(cache, -30, NOW)).toBe(false);
    });
  });

  it('counts lock file and local tfstate as activity (CLI-only workflows)', async () => {
    const cache = makeModule(root, 'cli', 60, 60);
    const mod = join(cache, '..');
    // terraform apply with a local backend touches the state, not the .tf files
    writeFileSync(join(mod, 'terraform.tfstate'), '{}');
    touch(join(mod, 'terraform.tfstate'), 2);
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);

    const cache2 = makeModule(root, 'locked', 60, 60);
    writeFileSync(join(cache2, '..', '.terraform.lock.hcl'), '');
    touch(join(cache2, '..', '.terraform.lock.hcl'), 2);
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  it('counts workspace state written under terraform.tfstate.d as activity', async () => {
    const cache = makeModule(root, 'workspaces', 60, 60);
    const mod = join(cache, '..');
    // terraform workspace select prod + apply: the state lives one level deeper,
    // and the terraform.tfstate.d dir mtime does not move when it is rewritten
    mkdirSync(join(mod, 'terraform.tfstate.d', 'prod'), { recursive: true });
    writeFileSync(join(mod, 'terraform.tfstate.d', 'prod', 'terraform.tfstate'), '{}');
    touch(join(mod, 'terraform.tfstate.d', 'prod', 'terraform.tfstate'), 1);
    touch(join(mod, 'terraform.tfstate.d', 'prod'), 1);
    touch(join(mod, 'terraform.tfstate.d'), 60);

    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  it('still deletes when the workspace state is itself old', async () => {
    const cache = makeModule(root, 'coldworkspaces', 60, 60);
    const mod = join(cache, '..');
    mkdirSync(join(mod, 'terraform.tfstate.d', 'prod'), { recursive: true });
    writeFileSync(join(mod, 'terraform.tfstate.d', 'prod', 'terraform.tfstate'), '{}');
    for (const p of [
      join(mod, 'terraform.tfstate.d', 'prod', 'terraform.tfstate'),
      join(mod, 'terraform.tfstate.d', 'prod'),
      join(mod, 'terraform.tfstate.d'),
    ]) {
      touch(p, 60);
    }
    expect((await findStaleTerraformDirs(root, 30, NOW)).map((s) => s.dir)).toEqual([cache]);
  });

  it('respects the staleDays threshold', async () => {
    makeModule(root, 'old', 20, 20);
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
    expect(await findStaleTerraformDirs(root, 10, NOW)).toHaveLength(1);
  });

  it('never follows symlinks out of the scanned root', async () => {
    makeModule(outside, 'target', 60, 60); // stale, but outside the workspace
    symlinkSync(join(outside, 'target'), join(root, 'link'));
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  it('skips a .terraform that is itself a symlink', async () => {
    const target = makeModule(outside, 'target', 60, 60);
    const mod = join(root, 'mod');
    mkdirSync(mod, { recursive: true });
    writeFileSync(join(mod, 'main.tf'), 'resource "a" "b" {}');
    touch(join(mod, 'main.tf'), 60);
    symlinkSync(target, join(mod, '.terraform'));
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  /** .terraform/environment holds the selected workspace and
   *  .terraform/terraform.tfstate the resolved backend config. Both are a few
   *  hundred bytes terraform init cannot reconstruct on its own: wiping them
   *  silently moves a user off `prod` and back to `default`. */
  it('deletes the cached payload but keeps workspace and backend metadata', async () => {
    const cache = makeModule(root, 'meta', 60, 60);
    mkdirSync(join(cache, 'modules'), { recursive: true });
    writeFileSync(join(cache, 'modules', 'mod.json'), '{}');
    writeFileSync(join(cache, 'environment'), 'prod');
    writeFileSync(join(cache, 'terraform.tfstate'), '{"backend":{}}');

    // providers + modules; the metadata files beside them are left in place
    expect(await deleteCachePayload(cache, root)).toEqual({ ok: true, removed: 2 });

    expect(existsSync(join(cache, 'providers'))).toBe(false);
    expect(existsSync(join(cache, 'modules'))).toBe(false);
    expect(readFileSync(join(cache, 'environment'), 'utf8')).toBe('prod');
    expect(existsSync(join(cache, 'terraform.tfstate'))).toBe(true);
  });

  /** Deleting `.terraform` itself only ever unlinked a symlink. Descending to
   *  `.terraform/providers` resolves *through* it, so a linked cache would have
   *  had the real directory on the other side emptied — outside the workspace. */
  it('never deletes through a .terraform that is a symlink', async () => {
    const target = makeModule(outside, 'target', 60, 60);
    const mod = join(root, 'mod');
    mkdirSync(mod, { recursive: true });
    symlinkSync(target, join(mod, '.terraform'));

    const result = await deleteCachePayload(join(mod, '.terraform'), root);

    expect(result.ok).toBe(false);
    expect(existsSync(join(target, 'providers', 'bin'))).toBe(true);
  });

  /** `rm` resolves symlinks in *parent* components — only the final one is
   *  lstat-protected — so the name check plus an `lstat` left a window: anything
   *  swapping `.terraform` for a symlink between the two (a direnv hook, a
   *  `make init` doing `rm -rf .terraform && ln -s`) redirected the recursive
   *  delete out of the workspace entirely. */
  it('refuses a .terraform that resolves outside the workspace root', async () => {
    const target = makeModule(outside, 'linked', 60, 60);
    const mod = join(root, 'mod');
    mkdirSync(mod, { recursive: true });
    symlinkSync(target, join(mod, '.terraform'));

    const result = await deleteCachePayload(join(mod, '.terraform'), root);

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('not a real directory'),
    });
    expect(existsSync(join(target, 'providers', 'bin'))).toBe(true);
  });

  /** The containment proof must survive the guard passing: a real .terraform at
   *  scan time whose *parent* is a link out of the tree still has to be caught,
   *  since that is what `rm` would follow. */
  it('refuses when a parent component links outside the workspace', async () => {
    const realMod = join(outside, 'real');
    const cache = join(realMod, '.terraform');
    mkdirSync(join(cache, 'providers'), { recursive: true });
    writeFileSync(join(cache, 'providers', 'bin'), 'precious');
    // root/link -> outside/real, so root/link/.terraform is a genuine directory
    symlinkSync(realMod, join(root, 'link'));

    const result = await deleteCachePayload(join(root, 'link', '.terraform'), root);

    expect(result.ok).toBe(false);
    expect(existsSync(join(cache, 'providers', 'bin'))).toBe(true);
  });

  it('reports a refusal rather than looking like a successful clean', async () => {
    const victim = join(root, 'notacache');
    mkdirSync(victim, { recursive: true });
    const result = await deleteCachePayload(victim, root);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('.terraform') });
  });

  it('does not count a symlinked payload it will not actually delete', async () => {
    const shared = join(outside, 'shared');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'big'), 'x'.repeat(50_000));
    const mod = join(root, 'linked');
    const cache = join(mod, '.terraform');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(mod, 'main.tf'), 'x = 1');
    // a shared plugin cache: rm unlinks the link, so nothing here is reclaimed
    symlinkSync(shared, join(cache, 'providers'));
    touch(join(mod, 'main.tf'), 90);
    // lutimes, not utimes: the latter follows the link and would age the target
    // instead, leaving the link itself mtime-now and the module merely "active"
    const old = new Date(NOW - 90 * DAY);
    lutimesSync(join(cache, 'providers'), old, old);
    touch(cache, 90);

    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
    expect(existsSync(join(shared, 'big'))).toBe(true);
  });

  /** Terraform <= 0.13 kept provider binaries in .terraform/plugins. Those are
   *  exactly the caches old enough to trip a 30-day threshold. */
  it('reclaims the pre-0.14 plugins layout', async () => {
    const mod = join(root, 'legacy');
    const cache = join(mod, '.terraform');
    mkdirSync(join(cache, 'plugins', 'linux_amd64'), { recursive: true });
    writeFileSync(join(cache, 'plugins', 'linux_amd64', 'bin'), 'x'.repeat(4096));
    // terraform writes this beside the plugins it installed itself
    writeFileSync(join(cache, 'plugins', 'linux_amd64', 'lock.json'), '{}');
    writeFileSync(join(mod, 'main.tf'), 'x = 1');
    for (const p of [
      join(cache, 'plugins', 'linux_amd64', 'bin'),
      join(cache, 'plugins', 'linux_amd64'),
      join(cache, 'plugins'),
      join(mod, 'main.tf'),
      cache,
    ]) {
      touch(p, 90);
    }
    const [found] = await findStaleTerraformDirs(root, 30, NOW);
    expect(found?.dir).toBe(cache);

    // one entry removed: plugins/linux_amd64
    expect(await deleteCachePayload(cache, root)).toEqual({ ok: true, removed: 1 });
    expect(existsSync(join(cache, 'plugins', 'linux_amd64'))).toBe(false);
  });

  /** Terraform 0.12 documented .terraform/plugins/<os>_<arch>/ as a plugin
   *  *search path*: an in-house provider with no registry source address was
   *  installed by dropping the binary there by hand. No terraform init brings
   *  that back, and those are exactly the caches old enough to trip the
   *  threshold. Absent terraform's own lock.json, the directory is left alone. */
  it('keeps a hand-installed plugin binary that terraform init cannot refetch', async () => {
    const mod = join(root, 'inhouse');
    const cache = join(mod, '.terraform');
    const platform = join(cache, 'plugins', 'linux_amd64');
    mkdirSync(platform, { recursive: true });
    writeFileSync(join(platform, 'terraform-provider-acme_v0.4.2'), 'ELF');
    mkdirSync(join(cache, 'providers'), { recursive: true });
    writeFileSync(join(cache, 'providers', 'bin'), 'refetchable');

    // only `providers` is reclaimed — the hand-placed platform dir is declined,
    // so it must not be counted as something this delete removed
    expect(await deleteCachePayload(cache, root)).toEqual({ ok: true, removed: 1 });

    expect(existsSync(join(platform, 'terraform-provider-acme_v0.4.2'))).toBe(true);
    // the registry-managed half is still reclaimed
    expect(existsSync(join(cache, 'providers'))).toBe(false);
  });

  /** The 0.13 nested layout is unambiguously registry-managed. */
  it('reclaims the nested registry plugins layout without a lock.json', async () => {
    const cache = join(root, 'nested', '.terraform');
    const nested = join(cache, 'plugins', 'registry.terraform.io', 'hashicorp', 'aws');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'bin'), 'x');

    expect(await deleteCachePayload(cache, root)).toEqual({ ok: true, removed: 1 });
    expect(existsSync(join(cache, 'plugins', 'registry.terraform.io'))).toBe(false);
  });

  /** The size total is display-only and deliberately bounded, so it must not be
   *  what decides whether a cache is reported at all. */
  it('reports a cache whose payload sits below the size walk depth cap', async () => {
    const mod = join(root, 'deep');
    const cache = join(mod, '.terraform');
    let dir = join(cache, 'modules');
    for (let i = 0; i < 40; i++) dir = join(dir, `d${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bin'), 'x'.repeat(4096));
    writeFileSync(join(mod, 'main.tf'), 'x = 1');
    touch(join(mod, 'main.tf'), 90);
    touch(join(cache, 'modules'), 90);
    touch(cache, 90);

    expect((await findStaleTerraformDirs(root, 30, NOW)).map((c) => c.dir)).toContain(cache);
  });

  it('refuses to touch anything not named .terraform', async () => {
    const victim = join(root, 'important');
    mkdirSync(join(victim, 'providers'), { recursive: true });
    writeFileSync(join(victim, 'providers', 'keep'), 'x');
    expect((await deleteCachePayload(victim, root)).ok).toBe(false);
    expect(existsSync(join(victim, 'providers', 'keep'))).toBe(true);
  });

  /** An unwritable subdir used to throw straight out of the delete loop, so
   *  `modules` was never attempted and the half-deleted provider tree left
   *  terraform init failing with "could not find executable file" instead of
   *  simply re-downloading. */
  it('still cleans the remaining subdirs when one of them fails', async () => {
    const cache = join(root, 'partial', '.terraform');
    mkdirSync(join(cache, 'providers', 'locked', 'inner'), { recursive: true });
    writeFileSync(join(cache, 'providers', 'locked', 'inner', 'bin'), 'x');
    mkdirSync(join(cache, 'modules'), { recursive: true });
    writeFileSync(join(cache, 'modules', 'mod.json'), '{}');
    chmodSync(join(cache, 'providers', 'locked'), 0o500);

    try {
      const result = await deleteCachePayload(cache, root);
      expect(result.ok).toBe(false);
      // the failure is named rather than swallowed
      expect(result.ok === false && result.reason).toContain('providers');
      // and the subdir after the failure was still attempted
      expect(existsSync(join(cache, 'modules'))).toBe(false);
    } finally {
      chmodSync(join(cache, 'providers', 'locked'), 0o700);
    }
  });

  /** The deletion leaves .terraform standing, so a cache with nothing left to
   *  reclaim must drop out of the results — otherwise the same folders are
   *  reported, and prompted for, on every single launch. */
  it('does not report a cache with no reclaimable payload', async () => {
    const mod = join(root, 'metaonly');
    mkdirSync(join(mod, '.terraform'), { recursive: true });
    writeFileSync(join(mod, 'main.tf'), 'x = 1');
    writeFileSync(join(mod, '.terraform', 'environment'), 'prod');
    touch(join(mod, 'main.tf'), 90);
    touch(join(mod, '.terraform', 'environment'), 90);
    touch(join(mod, '.terraform'), 90);
    expect(await findStaleTerraformDirs(root, 30, NOW)).toEqual([]);
  });

  it('sizes only the bytes it will actually reclaim', async () => {
    const cache = makeModule(root, 'sized', 60, 60);
    // metadata sits beside the payload and must not inflate the reported figure
    writeFileSync(join(cache, 'environment'), 'x'.repeat(4096));
    touch(join(cache, 'environment'), 60);
    touch(cache, 60); // the write above bumped the cache dir's own mtime
    const [found] = await findStaleTerraformDirs(root, 30, NOW);
    expect(found!.sizeBytes).toBe(2048);
  });

  it('only ever treats dirs literally named .terraform as cache', () => {
    expect(isTerraformCacheDir('/x/y/.terraform')).toBe(true);
    expect(isTerraformCacheDir('/x/y/.terraform-backup')).toBe(false);
    expect(isTerraformCacheDir('/x/y/state')).toBe(false);
  });

  it('formats sizes for humans', () => {
    expect(formatSize(500)).toBe('1 KB');
    expect(formatSize(5 * 1_048_576)).toBe('5.0 MB');
    expect(formatSize(2.5 * 1_073_741_824)).toBe('2.5 GB');
  });
});

describe('scan depth', () => {
  /** Build a module `depth` directories below root and return its cache path.
   *  The cache carries a providers payload: an empty .terraform has nothing to
   *  reclaim and is deliberately not reported. */
  function nest(depth: number, name: string): string {
    let dir = root;
    for (let i = 0; i < depth; i++) dir = join(dir, `d${i}`);
    mkdirSync(join(dir, '.terraform', 'providers'), { recursive: true });
    writeFileSync(join(dir, '.terraform', 'providers', 'bin'), 'x'.repeat(2048));
    writeFileSync(join(dir, 'main.tf'), 'x = 1');
    touch(join(dir, 'main.tf'), 90);
    // after the writes: creating an entry bumps its parent's mtime, and
    // lastActivity reads .terraform's children as well as .terraform itself
    touch(join(dir, '.terraform', 'providers', 'bin'), 90);
    touch(join(dir, '.terraform', 'providers'), 90);
    touch(join(dir, '.terraform'), 90);
    return join(dir, name);
  }

  it('reaches a module nested deeper than the old 16-level cap', async () => {
    const cache = nest(20, '.terraform');
    const found = await findStaleTerraformDirs(root, 30, NOW);
    expect(found.map((c) => c.dir)).toContain(cache);
  });

  it('reports the directory it stopped at instead of skipping in silence', async () => {
    nest(40, '.terraform');
    const skipped: string[] = [];
    const found = await findStaleTerraformDirs(root, 30, NOW, (d) => skipped.push(d));
    expect(found).toHaveLength(0);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('does not walk dependency trees', async () => {
    const buried = join(root, 'node_modules', 'pkg');
    mkdirSync(join(buried, '.terraform'), { recursive: true });
    writeFileSync(join(buried, 'main.tf'), 'x = 1');
    touch(join(buried, 'main.tf'), 90);
    touch(join(buried, '.terraform'), 90);
    expect(await findStaleTerraformDirs(root, 30, NOW)).toHaveLength(0);
  });
});
