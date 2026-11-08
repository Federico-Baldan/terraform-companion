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
  collectProviderSources,
  configuredProviderCache,
  deleteCachePayload,
  deleteProviderCacheEntry,
  findStaleProviderCacheEntries,
  findStaleTerraformDirs,
  formatSize,
  isAbsoluteFsPath,
  isProviderEntryStillStale,
  isStillStale,
  isTerraformCacheDir,
  providerSourcesFromLockFile,
} from '../src/features/cacheCleaner';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 16);

function touch(path: string, ageDays: number): void {
  const t = new Date(NOW - ageDays * DAY);
  utimesSync(path, t, t);
}

let root: string;
let outside: string;

/** The environment Terraform itself reads for the plugin cache. Saved and
 *  restored around every test, since a leaked value would point the next test
 *  at somebody's real cache. */
const ENV_KEYS = [
  'TF_CLI_CONFIG_FILE',
  'TERRAFORM_CONFIG',
  'TF_PLUGIN_CACHE_DIR',
  'TFC_TEST_CACHE_BASE',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tfc-cache-'));
  outside = mkdtempSync(join(tmpdir(), 'tfc-outside-'));
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
  it('protects provider sources named by lock files', () => {
    const sources = providerSourcesFromLockFile(`
provider "registry.terraform.io/hashicorp/aws" {
  hashes = ["h1:abc"]
}
provider "registry.terraform.io/hashicorp/random" {
  hashes = ["h1:def"]
}
`);
    expect([...sources]).toEqual([
      'registry.terraform.io/hashicorp/aws',
      'registry.terraform.io/hashicorp/random',
    ]);
  });

  it('finds and deletes stale providers from an unreferenced source only', async () => {
    const cache = join(root, 'plugin-cache');
    const stale = join(cache, 'registry.terraform.io', 'example', 'unused', '1.0.0');
    const protectedVersion = join(cache, 'registry.terraform.io', 'hashicorp', 'aws', '5.0.0');
    // Terraform's layout: <version>/<os_arch>/<binary>
    mkdirSync(join(stale, 'linux_amd64'), { recursive: true });
    mkdirSync(join(protectedVersion, 'linux_amd64'), { recursive: true });
    writeFileSync(join(stale, 'linux_amd64', 'provider'), 'x'.repeat(2048));
    writeFileSync(join(protectedVersion, 'linux_amd64', 'provider'), 'x');
    // the files are part of the entry's activity now, so they age with it
    for (const dir of [stale, protectedVersion]) {
      touch(join(dir, 'linux_amd64', 'provider'), 60);
      touch(join(dir, 'linux_amd64'), 60);
      touch(dir, 60);
    }

    const found = await findStaleProviderCacheEntries(
      cache,
      new Set(['registry.terraform.io/hashicorp/aws']),
      30,
      NOW,
    );
    expect(found.map((entry) => entry.source)).toEqual(['registry.terraform.io/example/unused']);
    expect((await deleteProviderCacheEntry(found[0]!, cache)).ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(protectedVersion)).toBe(true);
  });

  /** Terraform links a cached provider into a project and never touches the
   *  cache entry again, so the version directory's own mtime is the install
   *  date. Anything written below it is the only sign of life there is. */
  describe('provider activity', () => {
    function busyProvider(): { cache: string; version: string; binary: string } {
      const cache = join(root, 'plugin-cache');
      const version = join(cache, 'registry.terraform.io', 'example', 'busy', '1.0.0');
      const platform = join(version, 'linux_amd64');
      mkdirSync(platform, { recursive: true });
      const binary = join(platform, 'terraform-provider-busy');
      writeFileSync(binary, 'x'.repeat(2048));
      touch(binary, 90);
      touch(platform, 90);
      touch(version, 90);
      return { cache, version, binary };
    }

    it('does not offer a provider with a recently written file under an old version dir', async () => {
      const { cache, binary } = busyProvider();
      touch(binary, 2);
      expect(await findStaleProviderCacheEntries(cache, new Set(), 30, NOW)).toEqual([]);
    });

    it('reports the newest activity under the version dir, not the install date', async () => {
      const { cache, version, binary } = busyProvider();
      touch(binary, 45);
      const [found] = await findStaleProviderCacheEntries(cache, new Set(), 30, NOW);
      expect(found?.dir).toBe(version);
      expect(found?.lastActivityMs).toBe(NOW - 45 * DAY);
    });

    it('re-checks staleness against the files, so a prompt left open cannot delete a fresh install', async () => {
      const { version, binary } = busyProvider();
      expect(await isProviderEntryStillStale(version, 30, NOW)).toBe(true);
      touch(binary, 1);
      expect(await isProviderEntryStillStale(version, 30, NOW)).toBe(false);
    });
  });

  /** Terraform only checks that `plugin_cache_dir` exists, so a path that is not a
   *  plugin cache at all is still handed over. The sweep must refuse anything
   *  that does not look like `<host>/<namespace>/<type>/<version>/<os_arch>`,
   *  or any directory four levels deep becomes "a provider". */
  describe('provider cache layout', () => {
    it('offers only <host>/<namespace>/<type>/<semver>/<os_arch> entries', async () => {
      const cache = join(root, 'cache');
      const stray = join(cache, 'Documents', 'projects', 'client-a', 'backups');
      mkdirSync(stray, { recursive: true });
      writeFileSync(join(stray, 'irreplaceable.txt'), 'x');
      touch(join(stray, 'irreplaceable.txt'), 90);
      touch(stray, 90);
      // a version directory with no os_arch directory inside is not an install either
      const noPlatform = join(cache, 'registry.terraform.io', 'example', 'half', '1.0.0');
      mkdirSync(noPlatform, { recursive: true });
      touch(noPlatform, 90);
      const real = join(cache, 'registry.terraform.io', 'example', 'unused', '1.0.0');
      mkdirSync(join(real, 'linux_amd64'), { recursive: true });
      writeFileSync(join(real, 'linux_amd64', 'terraform-provider-unused'), 'x');
      for (const p of [
        join(real, 'linux_amd64', 'terraform-provider-unused'),
        join(real, 'linux_amd64'),
        real,
      ])
        touch(p, 90);

      const found = await findStaleProviderCacheEntries(cache, new Set(), 30, NOW);
      expect(found.map((e) => e.source)).toEqual(['registry.terraform.io/example/unused']);
    });

    /** Each guard alone, with the rest of the path valid, so that dropping one
     *  cannot be hidden by another. */
    it.each([
      ['a host that is not a domain', ['Documents', 'ns', 'type', '1.0.0', 'linux_amd64']],
      [
        'a version that is not semver',
        ['registry.terraform.io', 'ns', 'type', 'latest', 'linux_amd64'],
      ],
      ['no os_arch directory', ['registry.terraform.io', 'ns', 'type', '1.0.0', 'backups']],
    ])('does not offer %s', async (_name, parts) => {
      const cache = join(root, 'cache');
      const platform = join(cache, ...(parts as string[]));
      mkdirSync(platform, { recursive: true });
      writeFileSync(join(platform, 'file'), 'x');
      for (let i = parts.length; i > 0; i--)
        touch(join(cache, ...(parts as string[]).slice(0, i)), 90);
      touch(join(platform, 'file'), 90);
      expect(await findStaleProviderCacheEntries(cache, new Set(), 30, NOW)).toEqual([]);
    });

    it('accepts pre-release versions', async () => {
      const cache = join(root, 'cache');
      const real = join(cache, 'registry.terraform.io', 'example', 'beta', '2.0.0-beta.1');
      mkdirSync(join(real, 'darwin_arm64'), { recursive: true });
      touch(join(real, 'darwin_arm64'), 90);
      touch(real, 90);
      const found = await findStaleProviderCacheEntries(cache, new Set(), 30, NOW);
      expect(found).toHaveLength(1);
    });
  });

  /** The guard is the last line before `rm -rf`, and it was exercised only on
   *  the happy path. */
  describe('deleteProviderCacheEntry guards', () => {
    const entry = (dir: string) => ({ dir, source: 'x', sizeBytes: 0, lastActivityMs: 0 });
    const version = (cache: string, ...parts: string[]) => {
      const dir = join(cache, ...parts, '1.0.0');
      mkdirSync(join(dir, 'linux_amd64'), { recursive: true });
      writeFileSync(join(dir, 'linux_amd64', 'bin'), 'x');
      return dir;
    };

    it('refuses the cache root itself', async () => {
      const cache = join(root, 'cache');
      version(cache, 'registry.terraform.io', 'a', 'b');
      expect((await deleteProviderCacheEntry(entry(cache), cache)).ok).toBe(false);
      expect(existsSync(cache)).toBe(true);
    });

    it('refuses an entry outside the cache root', async () => {
      const cache = join(root, 'cache');
      mkdirSync(cache);
      const elsewhere = join(outside, 'precious');
      mkdirSync(elsewhere);
      expect((await deleteProviderCacheEntry(entry(elsewhere), cache)).ok).toBe(false);
      expect(existsSync(elsewhere)).toBe(true);
    });

    it('refuses an entry that is itself a symlink', async () => {
      const cache = join(root, 'cache');
      const real = version(cache, 'registry.terraform.io', 'a', 'b');
      const link = join(cache, 'registry.terraform.io', 'a', 'b', '2.0.0');
      symlinkSync(real, link);
      expect((await deleteProviderCacheEntry(entry(link), cache)).ok).toBe(false);
      expect(existsSync(real)).toBe(true);
    });

    /** The scan skips symlinked levels, but the prompt can sit open for hours: a
     *  level swapped for a link meanwhile must not redirect the delete onto an
     *  entry the user never saw — or one a lock file protects. */
    it('refuses a path that runs through a symlink swapped in after the scan', async () => {
      const cache = join(root, 'cache');
      const protectedVersion = version(cache, 'registry.terraform.io', 'hashicorp', 'aws');
      mkdirSync(join(cache, 'h'), { recursive: true });
      symlinkSync(join(cache, 'registry.terraform.io', 'hashicorp'), join(cache, 'h', 'n'));
      const viaLink = join(cache, 'h', 'n', 'aws', '1.0.0');
      expect((await deleteProviderCacheEntry(entry(viaLink), cache)).ok).toBe(false);
      expect(existsSync(protectedVersion)).toBe(true);
    });
  });

  describe('isAbsoluteFsPath', () => {
    it('does not take a drive-less rooted path for absolute on Windows', () => {
      // `$HOME/x` with HOME unset expands to `/x`, which win32 resolves against the cwd's drive
      expect(isAbsoluteFsPath('/x', 'win32')).toBe(false);
      expect(isAbsoluteFsPath('C:\\Users\\x', 'win32')).toBe(true);
      expect(isAbsoluteFsPath('C:/Users/x', 'win32')).toBe(true);
      expect(isAbsoluteFsPath('\\\\server\\share\\x', 'win32')).toBe(true);
    });

    it('keeps the ordinary POSIX rule elsewhere', () => {
      expect(isAbsoluteFsPath('/x', 'linux')).toBe(true);
      expect(isAbsoluteFsPath('x/y', 'linux')).toBe(false);
    });
  });

  describe('collectProviderSources', () => {
    const LOCK = 'provider "registry.terraform.io/hashicorp/aws" {\n  version = "5.0.0"\n}\n';

    it('reads every lock file in the tree and reports a complete scan', async () => {
      mkdirSync(join(root, 'infra', 'prod'), { recursive: true });
      writeFileSync(join(root, 'infra', 'prod', '.terraform.lock.hcl'), LOCK);
      const { sources, complete } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
      expect(complete).toBe(true);
    });

    it('follows a symlinked lock file, which monorepos use to share one', async () => {
      writeFileSync(join(outside, 'shared.lock.hcl'), LOCK);
      mkdirSync(join(root, 'mod'));
      symlinkSync(join(outside, 'shared.lock.hcl'), join(root, 'mod', '.terraform.lock.hcl'));
      const { sources, complete } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
      expect(complete).toBe(true);
    });

    it('follows a symlinked directory, whose lock file is a project the workspace still uses', async () => {
      mkdirSync(join(outside, 'shared-project'));
      writeFileSync(join(outside, 'shared-project', '.terraform.lock.hcl'), LOCK);
      symlinkSync(join(outside, 'shared-project'), join(root, 'linked'));
      const { sources, complete } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
      expect(complete).toBe(true);
    });

    it('terminates on a symlink loop', async () => {
      mkdirSync(join(root, 'a'));
      symlinkSync(root, join(root, 'a', 'back'));
      writeFileSync(join(root, 'a', '.terraform.lock.hcl'), LOCK);
      const { sources } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
    });

    it('reads lock files under .terragrunt-cache, which is where terragrunt keeps real projects', async () => {
      const dir = join(root, 'live', '.terragrunt-cache', 'abc', 'def');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.terraform.lock.hcl'), LOCK);
      const { sources } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
    });

    it('protects what an initialised project links in, even when its lock file is missing', async () => {
      const providers = join(root, 'proj', '.terraform', 'providers');
      mkdirSync(
        join(providers, 'registry.terraform.io', 'hashicorp', 'aws', '5.0.0', 'linux_amd64'),
        {
          recursive: true,
        },
      );
      const { sources, complete } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
      expect(complete).toBe(true);
    });

    it('says the scan is incomplete when a lock file cannot be read', async () => {
      mkdirSync(join(root, 'mod'));
      // a dangling link is unreadable whoever runs the test, root included
      symlinkSync(join(outside, 'missing.hcl'), join(root, 'mod', '.terraform.lock.hcl'));
      const { complete } = await collectProviderSources(root);
      expect(complete).toBe(false);
    });

    it('says the scan is incomplete when the depth limit hides part of the tree', async () => {
      mkdirSync(join(root, ...Array.from({ length: 40 }, () => 'd')), { recursive: true });
      const { complete } = await collectProviderSources(root);
      expect(complete).toBe(false);
    });

    /** Following links is what lets a lock file behind one protect its
     *  providers, so a link that could not be followed is a project nobody read. */
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'says the scan is incomplete when a linked directory cannot be reached',
      async () => {
        const locked = join(outside, 'locked');
        mkdirSync(join(locked, 'proj'), { recursive: true });
        writeFileSync(join(locked, 'proj', '.terraform.lock.hcl'), LOCK);
        symlinkSync(join(locked, 'proj'), join(root, 'linked'));
        chmodSync(locked, 0o000);
        try {
          const { complete } = await collectProviderSources(root);
          expect(complete).toBe(false);
        } finally {
          chmodSync(locked, 0o700);
        }
      },
    );

    it('ignores a link in a loop, and a link through a file: neither leads to a project', async () => {
      symlinkSync('loop', join(root, 'loop'));
      writeFileSync(join(root, 'file'), 'x');
      symlinkSync(join(root, 'file', 'x'), join(root, 'through-file'));
      expect((await collectProviderSources(root)).complete).toBe(true);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'says the scan is incomplete when what a symlinked .terraform links in cannot be listed',
      async () => {
        const real = join(outside, 'dot-terraform');
        mkdirSync(join(real, 'providers'), { recursive: true });
        mkdirSync(join(root, 'proj'));
        symlinkSync(real, join(root, 'proj', '.terraform'));
        chmodSync(join(real, 'providers'), 0o000);
        try {
          expect((await collectProviderSources(root)).complete).toBe(false);
        } finally {
          chmodSync(join(real, 'providers'), 0o700);
        }
      },
    );

    it('counts entries across the whole walk, not per directory, and says the limit was why', async () => {
      let dir = root;
      for (let i = 0; i < 6; i++) {
        dir = join(dir, `d${i}`);
        mkdirSync(dir);
        writeFileSync(join(dir, 'f.tf'), '');
      }
      // no directory holds more than two entries, the tree holds twelve
      const scan = await collectProviderSources(root, undefined, 8);
      expect(scan.complete).toBe(false);
      expect(scan.limited).toBe(true);
      mkdirSync(join(outside, 'mod'));
      symlinkSync(join(outside, 'missing.hcl'), join(outside, 'mod', '.terraform.lock.hcl'));
      const unreadable = await collectProviderSources(join(outside, 'mod'));
      expect(unreadable.complete).toBe(false);
      expect(unreadable.limited).toBe(false);
    });

    /** What a project downloaded under .terraform/modules is somebody else's
     *  module, and a walk through it is what used up the budget in a terragrunt
     *  tree. Terraform reads one lock file, the root module's. */
    it('does not walk the modules a project downloaded', async () => {
      const downloaded = join(root, 'proj', '.terraform', 'modules', 'vpc');
      mkdirSync(downloaded, { recursive: true });
      writeFileSync(
        join(downloaded, '.terraform.lock.hcl'),
        'provider "registry.terraform.io/example/trap" {\n}\n',
      );
      writeFileSync(join(root, 'proj', '.terraform.lock.hcl'), LOCK);
      const { sources } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
    });

    it('ignores a link to nothing, which has no lock file to find', async () => {
      symlinkSync(join(outside, 'gone'), join(root, 'dangling'));
      const { complete } = await collectProviderSources(root);
      expect(complete).toBe(true);
    });

    /** A link to a big tree outside the workspace used to cost half a minute per
     *  walk, and a walk is repeated after the prompt. */
    it('says the scan is incomplete when it runs out of entries to read', async () => {
      for (let i = 0; i < 20; i++) writeFileSync(join(root, `f${i}.tf`), '');
      const { complete } = await collectProviderSources(root, undefined, 5);
      expect(complete).toBe(false);
      expect((await collectProviderSources(root)).complete).toBe(true);
    });

    it('protects what a symlinked .terraform links in', async () => {
      const real = join(outside, 'dot-terraform');
      mkdirSync(join(real, 'providers', 'registry.terraform.io', 'hashicorp', 'aws', '5.0.0'), {
        recursive: true,
      });
      mkdirSync(join(root, 'proj'));
      symlinkSync(real, join(root, 'proj', '.terraform'));
      const { sources } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
    });

    it('does not go looking in the providers a project links in', async () => {
      const providers = join(root, 'proj', '.terraform', 'providers');
      const nested = join(providers, 'registry.terraform.io', 'hashicorp', 'aws', '5.0.0');
      mkdirSync(nested, { recursive: true });
      // a lock file in there could only be one of the cache's own, found by a walk
      // that went through the link into the shared cache
      writeFileSync(
        join(nested, '.terraform.lock.hcl'),
        'provider "registry.terraform.io/example/trap" {\n}\n',
      );
      const { sources } = await collectProviderSources(root);
      expect([...sources]).toEqual(['registry.terraform.io/hashicorp/aws']);
    });
  });

  /** What Terraform itself does with the same two settings — see
   *  internal/command/cliconfig/cliconfig.go: the environment variable wins and
   *  is taken verbatim, the file value goes through os.ExpandEnv, and nothing
   *  expands `~`. */
  describe('configuredProviderCache', () => {
    function cliConfig(body: string): void {
      const file = join(root, 'terraform.rc');
      writeFileSync(file, body);
      process.env.TF_CLI_CONFIG_FILE = file;
    }

    it('prefers TF_PLUGIN_CACHE_DIR over the file, verbatim', async () => {
      cliConfig(`plugin_cache_dir = "${join(root, 'from-file')}"\n`);
      process.env.TF_PLUGIN_CACHE_DIR = join(root, 'from-env', '$NOT_EXPANDED');
      expect(await configuredProviderCache()).toBe(join(root, 'from-env', '$NOT_EXPANDED'));
    });

    it('expands $VAR and ${VAR} in the file value', async () => {
      process.env.TFC_TEST_CACHE_BASE = root;
      cliConfig('plugin_cache_dir = "$TFC_TEST_CACHE_BASE/plugins"\n');
      expect(await configuredProviderCache()).toBe(`${root}/plugins`);
      cliConfig('plugin_cache_dir = "${TFC_TEST_CACHE_BASE}/plugins"\n');
      expect(await configuredProviderCache()).toBe(`${root}/plugins`);
    });

    it('reads a value followed by a comment or written with CRLF line endings', async () => {
      const dir = join(root, 'plugins');
      cliConfig(`plugin_cache_dir = "${dir}" # shared\r\n`);
      expect(await configuredProviderCache()).toBe(dir);
      cliConfig(`plugin_cache_dir = "${dir}" // shared\n`);
      expect(await configuredProviderCache()).toBe(dir);
    });

    it('ignores a commented-out setting', async () => {
      cliConfig(`# plugin_cache_dir = "${join(root, 'plugins')}"\n`);
      expect(await configuredProviderCache()).toBeUndefined();
    });

    it('refuses a path that is not absolute, since the extension host has no say in the cwd', async () => {
      cliConfig('plugin_cache_dir = "relative/plugins"\n');
      expect(await configuredProviderCache()).toBeUndefined();
      // Terraform does not expand `~`, so the file value is a relative path to it too
      cliConfig('plugin_cache_dir = "~/plugins"\n');
      expect(await configuredProviderCache()).toBeUndefined();
    });

    it('refuses a relative TF_PLUGIN_CACHE_DIR', async () => {
      process.env.TF_PLUGIN_CACHE_DIR = 'relative/plugins';
      expect(await configuredProviderCache()).toBeUndefined();
    });

    it('ignores a setting inside a block or a block comment', async () => {
      const dir = join(root, 'plugins');
      cliConfig(
        `/* plugin_cache_dir = "${dir}" */\nprovider_installation {\n  plugin_cache_dir = "${dir}"\n}\n`,
      );
      expect(await configuredProviderCache()).toBeUndefined();
      cliConfig(`provider_installation {\n}\nplugin_cache_dir = "${dir}"\n`);
      expect(await configuredProviderCache()).toBe(dir);
    });

    it('takes TERRAFORM_CONFIG when TF_CLI_CONFIG_FILE is unset, like Terraform', async () => {
      const dir = join(root, 'legacy');
      const file = join(root, 'legacy.rc');
      writeFileSync(file, `plugin_cache_dir = "${dir}"\n`);
      process.env.TERRAFORM_CONFIG = file;
      expect(await configuredProviderCache()).toBe(dir);
      // and TF_CLI_CONFIG_FILE outranks it
      cliConfig(`plugin_cache_dir = "${join(root, 'preferred')}"\n`);
      expect(await configuredProviderCache()).toBe(join(root, 'preferred'));
    });

    /** Terraform reads ~/.terraformrc and then ~/.terraform.d/*.tfrc, the
     *  directory only when no override env var is set. There is no
     *  ~/.terraform.d/terraform.rc. */
    describe('from the home directory', () => {
      const realHome = process.env.HOME;
      afterEach(() => {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
      });
      const home = () => {
        const dir = join(root, 'home');
        mkdirSync(join(dir, '.terraform.d'), { recursive: true });
        process.env.HOME = dir;
        return dir;
      };

      it('reads ~/.terraform.d/*.tfrc, and the main file wins over it', async () => {
        const dir = home();
        writeFileSync(
          join(dir, '.terraform.d', 'cache.tfrc'),
          `plugin_cache_dir = "${join(root, 'from-dir')}"\n`,
        );
        expect(await configuredProviderCache()).toBe(join(root, 'from-dir'));
        writeFileSync(
          join(dir, '.terraformrc'),
          `plugin_cache_dir = "${join(root, 'from-main')}"\n`,
        );
        expect(await configuredProviderCache()).toBe(join(root, 'from-main'));
      });

      it('does not read ~/.terraform.d/terraform.rc, which Terraform never loads', async () => {
        const dir = home();
        writeFileSync(
          join(dir, '.terraform.d', 'terraform.rc'),
          `plugin_cache_dir = "${join(root, 'ghost')}"\n`,
        );
        expect(await configuredProviderCache()).toBeUndefined();
      });

      /** Terraform loads `*.tfrc` and `*.tfrc.json` from that directory in file
       *  name order, and the first file that sets the cache wins. */
      it('reads a *.tfrc.json file, in name order with the *.tfrc ones', async () => {
        const dir = home();
        writeFileSync(
          join(dir, '.terraform.d', 'b.tfrc'),
          `plugin_cache_dir = "${join(root, 'from-b')}"\n`,
        );
        writeFileSync(
          join(dir, '.terraform.d', 'a.tfrc.json'),
          JSON.stringify({ plugin_cache_dir: join(root, 'from-a') }),
        );
        expect(await configuredProviderCache()).toBe(join(root, 'from-a'));
        rmSync(join(dir, '.terraform.d', 'a.tfrc.json'));
        expect(await configuredProviderCache()).toBe(join(root, 'from-b'));
      });

      it('skips a *.tfrc.json file that is not valid JSON', async () => {
        const dir = home();
        writeFileSync(join(dir, '.terraform.d', 'a.tfrc.json'), '{ not json');
        writeFileSync(
          join(dir, '.terraform.d', 'b.tfrc'),
          `plugin_cache_dir = "${join(root, 'from-b')}"\n`,
        );
        expect(await configuredProviderCache()).toBe(join(root, 'from-b'));
      });

      it('refuses a cache that a mirror in another config file names', async () => {
        const dir = home();
        const shared = join(root, 'shared');
        mkdirSync(shared, { recursive: true });
        writeFileSync(join(dir, '.terraformrc'), `plugin_cache_dir = "${shared}"\n`);
        writeFileSync(
          join(dir, '.terraform.d', 'mirror.tfrc'),
          `provider_installation {\n  filesystem_mirror {\n    path = "${shared}"\n  }\n}\n`,
        );
        expect(await configuredProviderCache()).toBeUndefined();
      });

      it('skips the directory when an override env var is set', async () => {
        const dir = home();
        writeFileSync(
          join(dir, '.terraform.d', 'cache.tfrc'),
          `plugin_cache_dir = "${join(root, 'from-dir')}"\n`,
        );
        cliConfig('provider_installation {}\n');
        expect(await configuredProviderCache()).toBeUndefined();
      });
    });

    /** `~/.terraform.d/plugins` is Terraform's implied local mirror: same layout,
     *  but it holds providers placed by hand that nothing can restore. */
    it('refuses a directory that is a local provider mirror, not a cache', async () => {
      for (const dir of [
        join(root, '.terraform.d', 'plugins'),
        join(root, 'share', 'terraform', 'plugins'),
        join(root, 'Library', 'Application Support', 'io.terraform', 'plugins'),
      ]) {
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        expect(await configuredProviderCache()).toBeUndefined();
      }
      process.env.TF_PLUGIN_CACHE_DIR = join(root, '.terraform.d', 'plugin-cache');
      expect(await configuredProviderCache()).toBe(join(root, '.terraform.d', 'plugin-cache'));
    });

    /** The name alone says it is a mirror, wherever the link leads. */
    it('refuses a directory named like a local provider mirror, even if it is a link elsewhere', async () => {
      const real = join(root, 'real-cache');
      mkdirSync(real);
      mkdirSync(join(root, '.terraform.d'));
      const named = join(root, '.terraform.d', 'plugins');
      symlinkSync(real, named);
      process.env.TF_PLUGIN_CACHE_DIR = named;
      expect(await configuredProviderCache()).toBeUndefined();
    });

    it('refuses a directory that is a link to a local provider mirror', async () => {
      const mirror = join(root, '.terraform.d', 'plugins');
      mkdirSync(mirror, { recursive: true });
      const link = join(root, 'cache-link');
      symlinkSync(mirror, link);
      process.env.TF_PLUGIN_CACHE_DIR = link;
      expect(await configuredProviderCache()).toBeUndefined();
    });

    /** A refused path used to leave no trace, so a cache that was never swept
     *  looked the same as a cache that was not configured. */
    it('says why it refused a path', async () => {
      const logged: string[] = [];
      process.env.TF_PLUGIN_CACHE_DIR = 'relative/dir';
      expect(await configuredProviderCache((m) => logged.push(m))).toBeUndefined();
      expect(logged.join('\n')).toContain('relative/dir');
      expect(logged.join('\n')).toContain('absolute');

      logged.length = 0;
      process.env.TF_PLUGIN_CACHE_DIR = join(root, 'share', 'terraform', 'plugins');
      expect(await configuredProviderCache((m) => logged.push(m))).toBeUndefined();
      expect(logged.join('\n')).toContain('mirror');
    });

    /** HashiCorp: "The plugin cache directory must not also be one of the
     *  configured or implied filesystem mirror directories". A mirror holds
     *  providers placed by hand, in the layout of a cache, and the path is not
     *  expanded or checked by Terraform: it is taken as written. */
    describe('a configured filesystem mirror', () => {
      const withMirror = (dir: string) =>
        `provider_installation {\n  filesystem_mirror {\n    path = "${dir}"\n  }\n  direct {}\n}\n`;
      const cache = () => {
        const dir = join(root, 'shared');
        mkdirSync(dir, { recursive: true });
        return dir;
      };
      const refused = async (): Promise<string[]> => {
        const logged: string[] = [];
        expect(await configuredProviderCache((m) => logged.push(m))).toBeUndefined();
        return logged;
      };

      it('is refused as the cache, whichever way the cache was configured', async () => {
        const dir = cache();
        cliConfig(withMirror(dir));
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        expect((await refused()).join('\n')).toContain('filesystem_mirror');

        delete process.env.TF_PLUGIN_CACHE_DIR;
        cliConfig(`plugin_cache_dir = "${dir}"\n${withMirror(dir)}`);
        await refused();
      });

      it('is recognised through a trailing slash and through a symlink', async () => {
        const dir = cache();
        const link = join(root, 'link-to-shared');
        symlinkSync(dir, link);
        process.env.TF_PLUGIN_CACHE_DIR = link;
        cliConfig(withMirror(`${dir}/`));
        await refused();
      });

      it('is recognised written on one line, with a quoted key, or in JSON', async () => {
        const dir = cache();
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        cliConfig(`provider_installation { filesystem_mirror { path = "${dir}" } }\n`);
        await refused();
        cliConfig(
          `"provider_installation" {\n  "filesystem_mirror" {\n    "path" = "${dir}"\n  }\n}\n`,
        );
        await refused();

        const json = join(root, 'terraform.rc.json');
        writeFileSync(
          json,
          JSON.stringify({ provider_installation: { filesystem_mirror: { path: dir } } }),
        );
        process.env.TF_CLI_CONFIG_FILE = json;
        await refused();
        writeFileSync(
          json,
          JSON.stringify({
            provider_installation: [{ filesystem_mirror: [{ path: '/elsewhere' }, { path: dir }] }],
          }),
        );
        await refused();
      });

      it('is refused when any of several mirrors is the cache', async () => {
        const dir = cache();
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        cliConfig(
          `provider_installation {\n  filesystem_mirror {\n    path = "/elsewhere"\n  }\n  filesystem_mirror {\n    path = "${dir}"\n  }\n}\n`,
        );
        await refused();
      });

      it('does not matter when the mirror is somewhere else', async () => {
        const dir = cache();
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        cliConfig(withMirror(join(root, 'another-mirror')));
        expect(await configuredProviderCache()).toBe(dir);
      });

      it('is not read from a comment, or from a block that is not a mirror', async () => {
        const dir = cache();
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        cliConfig(
          `# filesystem_mirror { path = "${dir}" }\n/* provider_installation {\n  filesystem_mirror {\n    path = "${dir}"\n  }\n} */\nprovider_installation {\n  direct {\n    path = "${dir}"\n  }\n}\n`,
        );
        expect(await configuredProviderCache()).toBe(dir);
        // only provider_installation declares a mirror
        cliConfig(
          `unrelated {\n  filesystem_mirror {\n    path = "${dir}"\n  }\n}\nfilesystem_mirror {\n  path = "${dir}"\n}\n`,
        );
        expect(await configuredProviderCache()).toBe(dir);
      });

      /** Terraform takes a relative path against its own working directory, which
       *  the extension cannot know, so it could be the cache. Any doubt leaves the
       *  cache alone. */
      it('leaves the cache alone when a mirror path is relative, and says why', async () => {
        const dir = cache();
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        cliConfig(withMirror('providers'));
        expect((await refused()).join('\n')).toContain('relative');
      });

      it('does not expand variables in the path, as Terraform does not', async () => {
        const dir = cache();
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        process.env.TFC_TEST_MIRROR = dir;
        cliConfig(withMirror('$TFC_TEST_MIRROR'));
        // `$TFC_TEST_MIRROR` is a relative path to Terraform, hence the doubt
        expect((await refused()).join('\n')).toContain('relative');
        delete process.env.TFC_TEST_MIRROR;
      });

      /** HCL v1 takes a file for JSON when its first character is `{`, whatever
       *  the file is called. */
      it('tells JSON from HCL by what a file holds, not by its name', async () => {
        const dir = cache();
        const hclNamedJson = join(root, 'looks-like.tfrc.json');
        writeFileSync(hclNamedJson, `plugin_cache_dir = "${dir}"\n`);
        process.env.TF_CLI_CONFIG_FILE = hclNamedJson;
        expect(await configuredProviderCache()).toBe(dir);

        const jsonNamedRc = join(root, 'looks-like.tfrc');
        writeFileSync(jsonNamedRc, `  \n{"plugin_cache_dir": "${dir}"}`);
        process.env.TF_CLI_CONFIG_FILE = jsonNamedRc;
        expect(await configuredProviderCache()).toBe(dir);

        // and the mirrors are read the same way
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        writeFileSync(hclNamedJson, withMirror(dir));
        process.env.TF_CLI_CONFIG_FILE = hclNamedJson;
        await refused();
        writeFileSync(
          jsonNamedRc,
          JSON.stringify({ provider_installation: { filesystem_mirror: { path: dir } } }),
        );
        process.env.TF_CLI_CONFIG_FILE = jsonNamedRc;
        await refused();
      });

      it('says when it skipped a config file it could not parse', async () => {
        const dir = cache();
        process.env.TF_PLUGIN_CACHE_DIR = dir;
        const broken = join(root, 'broken.tfrc.json');
        writeFileSync(broken, '{ not json');
        process.env.TF_CLI_CONFIG_FILE = broken;
        const logged: string[] = [];
        expect(await configuredProviderCache((m) => logged.push(m))).toBe(dir);
        expect(logged.join('\n')).toContain(broken);
      });
    });

    it('reads a quoted key, which HCL allows', async () => {
      const dir = join(root, 'quoted');
      cliConfig(`"plugin_cache_dir" = "${dir}"\n`);
      expect(await configuredProviderCache()).toBe(dir);
    });

    it('is undefined when nothing configures a cache', async () => {
      cliConfig('provider_installation {}\n');
      expect(await configuredProviderCache()).toBeUndefined();
    });
  });

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

    // providers + modules; the metadata files beside them are left in place.
    // The names are asserted, not the count: they are what the prompt shows.
    expect(await deleteCachePayload(cache, root)).toEqual({
      ok: true,
      removed: ['providers', 'modules'],
    });

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

    expect(await deleteCachePayload(cache, root)).toEqual({
      ok: true,
      removed: ['plugins/linux_amd64'],
    });
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
    // so it must not be reported as something this delete removed
    expect(await deleteCachePayload(cache, root)).toEqual({ ok: true, removed: ['providers'] });

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

    expect(await deleteCachePayload(cache, root)).toEqual({
      ok: true,
      removed: ['plugins/registry.terraform.io'],
    });
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

  /** The prompt renders this list, so it has to be what the delete targets —
   *  same subdirs, same plugins lock.json rule — or the user approves one thing
   *  and gets another. */
  it('reports which directories a clean would remove', async () => {
    const cache = makeModule(root, 'named', 60, 60);
    mkdirSync(join(cache, 'modules'), { recursive: true });
    writeFileSync(join(cache, 'modules', 'mod.json'), '{}');
    mkdirSync(join(cache, 'plugins', 'linux_amd64'), { recursive: true });
    writeFileSync(join(cache, 'plugins', 'linux_amd64', 'lock.json'), '{}');
    // hand-placed, no lock.json: declined by the delete, so never listed
    mkdirSync(join(cache, 'plugins', 'darwin_arm64'), { recursive: true });
    writeFileSync(join(cache, 'plugins', 'darwin_arm64', 'terraform-provider-acme'), 'ELF');
    writeFileSync(join(cache, 'environment'), 'prod');
    for (const p of [
      join(cache, 'modules'),
      join(cache, 'plugins'),
      join(cache, 'environment'),
      cache,
    ]) {
      touch(p, 60);
    }

    const [found] = await findStaleTerraformDirs(root, 30, NOW);
    expect(found?.entries).toEqual(['providers', 'plugins/linux_amd64', 'modules']);
    // and the delete removes exactly that, nothing more
    expect(await deleteCachePayload(found!.dir, root)).toEqual({
      ok: true,
      removed: found!.entries,
    });
    expect(existsSync(join(cache, 'plugins', 'darwin_arm64'))).toBe(true);
    expect(readFileSync(join(cache, 'environment'), 'utf8')).toBe('prod');
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
