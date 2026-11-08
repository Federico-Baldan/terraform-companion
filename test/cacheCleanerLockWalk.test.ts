import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every path handed to `readFile` by the code under test. The wrapper delegates
 *  to the real one, so the scan still runs against a real temp tree. */
const reads = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((...args: Parameters<typeof actual.readFile>) => {
    reads.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

// imported after the mock is registered, so the scan sees the wrapper
const { scan } = await import('../src/features/cacheCleanerProvider');
const { mock, resetVscodeMock } = await import('./mocks/vscode');

const LOCK = '.terraform.lock.hcl';
const ENV_KEYS = ['TF_CLI_CONFIG_FILE', 'TF_PLUGIN_CACHE_DIR', 'TERRAFORM_CONFIG'] as const;
const savedEnv = new Map<string, string | undefined>();

let root: string;
let scratch: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tfc-lockwalk-'));
  scratch = mkdtempSync(join(tmpdir(), 'tfc-lockwalk-env-'));
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  // a CLI config that does not exist: `cliConfigFiles` honours the override and
  // stops there, so a developer's real ~/.terraformrc cannot leak into the test
  process.env.TF_CLI_CONFIG_FILE = join(scratch, 'absent.tfrc');
  reads.length = 0;
  resetVscodeMock();
  mock.folders = [{ uri: { fsPath: root } }];
  // a workspace with real projects, each holding a lock file
  for (const name of ['a', 'b', 'c']) {
    const dir = join(root, 'envs', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'main.tf'), 'resource "null_resource" "x" {}');
    writeFileSync(
      join(dir, LOCK),
      'provider "registry.terraform.io/hashicorp/aws" {\n  version = "5.0.0"\n}\n',
    );
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function memento(): never {
  const store = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
    update: async (k: string, v: unknown) => void store.set(k, v),
    keys: () => [...store.keys()],
  } as never;
}

const lockReads = () => reads.filter((p) => p.endsWith(LOCK));

describe('the lock-file walk of the cache cleaner', () => {
  /** The lock files only ever decide what the *shared plugin cache* sweep may
   *  delete. With no shared cache configured — the common case: it takes an
   *  explicit `plugin_cache_dir` or TF_PLUGIN_CACHE_DIR — nothing consumes them,
   *  yet the scan walked the whole workspace a second time and parsed every lock
   *  file it met, once per window every 24 hours. On 2000 projects that was ~2000
   *  extra readdirs and ~2000 file reads for a result that was thrown away. */
  it('reads no lock file when no shared plugin cache is configured', async () => {
    await scan(
      () => {},
      () => false,
      memento(),
    );
    expect(lockReads()).toEqual([]);
  });

  it('still reads them when a shared plugin cache is configured', async () => {
    // the other half of the contract: gating must not switch the protection off,
    // or the sweep would offer a provider a lock file names
    const cache = join(scratch, 'plugin-cache');
    mkdirSync(cache, { recursive: true });
    process.env.TF_PLUGIN_CACHE_DIR = cache;
    await scan(
      () => {},
      () => false,
      memento(),
    );
    expect(lockReads().length).toBeGreaterThanOrEqual(3);
  });

  it('reads none when the shared-cache setting is off, configured or not', async () => {
    const cache = join(scratch, 'plugin-cache');
    mkdirSync(cache, { recursive: true });
    process.env.TF_PLUGIN_CACHE_DIR = cache;
    mock.settings.set('cacheCleaner.sharedPluginCache', false);
    await scan(
      () => {},
      () => false,
      memento(),
    );
    expect(lockReads()).toEqual([]);
  });
});
