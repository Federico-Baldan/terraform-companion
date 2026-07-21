import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
  /** Build a module `depth` directories below root and return its cache path. */
  function nest(depth: number, name: string): string {
    let dir = root;
    for (let i = 0; i < depth; i++) dir = join(dir, `d${i}`);
    mkdirSync(join(dir, '.terraform'), { recursive: true });
    writeFileSync(join(dir, 'main.tf'), 'x = 1');
    touch(join(dir, 'main.tf'), 90);
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
