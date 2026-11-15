import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Runs once, immediately before the next `realpath` of the path it names: the
 *  instant between the delete's `lstat` of a victim and its proof of where the
 *  victim resolves, which is where another process can swap it. */
const swap = vi.hoisted(() => ({ at: undefined as string | undefined, run: () => {} }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const realpath = ((...args: Parameters<typeof actual.realpath>) => {
    if (swap.at !== undefined && String(args[0]) === swap.at) {
      swap.at = undefined;
      swap.run();
    }
    return actual.realpath(...args);
  }) as typeof actual.realpath;
  return { ...actual, default: { ...actual, realpath }, realpath };
});

// imported after the mock is registered, so the delete sees the wrapper
const { deleteCachePayload } = await import('../src/features/cacheCleaner');

let root: string;
let cache: string;

beforeEach(() => {
  // resolved, since the delete works on the real path and so must the swap
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tfc-swap-')));
  cache = join(root, 'mod', '.terraform');
  mkdirSync(join(cache, 'providers', 'registry.terraform.io'), { recursive: true });
  mkdirSync(join(cache, 'modules', 'vpc'), { recursive: true });
  writeFileSync(join(cache, 'modules', 'vpc', 'main.tf'), 'x');
  writeFileSync(join(cache, 'environment'), 'prod');
  writeFileSync(join(cache, 'terraform.tfstate'), '{"backend":{}}');
  swap.at = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The delete removes the path a victim *resolves* to, and proved only that
 *  this path was somewhere inside the cache. A victim swapped for a link that
 *  leads back into the same `.terraform` passed that proof, and what the link
 *  pointed at was removed in its place: for a link to `.`, the whole cache
 *  directory, with the selected workspace and the backend configuration that
 *  the delete exists to keep. A link placed there before the scan was already
 *  refused; this is the same link arriving between the check and the delete. */
describe('a cache subdirectory swapped for a link while it is being cleaned', () => {
  function swapFor(sub: string, target: string): void {
    const victim = join(cache, sub);
    swap.at = victim;
    swap.run = () => {
      renameSync(victim, join(root, `${sub}.moved`));
      symlinkSync(target, victim);
    };
  }

  it('does not remove the whole cache through a link to the cache itself', async () => {
    swapFor('providers', '.');

    const result = await deleteCachePayload(cache, root);

    expect(existsSync(cache)).toBe(true);
    expect(readFileSync(join(cache, 'environment'), 'utf8')).toBe('prod');
    expect(readFileSync(join(cache, 'terraform.tfstate'), 'utf8')).toBe('{"backend":{}}');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('providers') });
  });

  it('does not remove another part of the cache through a link to it', async () => {
    // `plugins` is cleaned entry by entry, each proved on its own
    mkdirSync(join(cache, 'plugins', 'registry.terraform.io'), { recursive: true });
    const victim = join(cache, 'plugins', 'registry.terraform.io');
    swap.at = victim;
    swap.run = () => {
      renameSync(victim, join(root, 'entry.moved'));
      symlinkSync(join('..', '..', '.terraform'), victim);
    };

    const result = await deleteCachePayload(cache, root);

    expect(readFileSync(join(cache, 'environment'), 'utf8')).toBe('prod');
    expect(result.ok).toBe(false);
  });

  it('still cleans a cache nothing touched', async () => {
    const result = await deleteCachePayload(cache, root);

    expect(result).toEqual({ ok: true, removed: ['providers', 'modules'] });
    expect(existsSync(join(cache, 'providers'))).toBe(false);
    expect(readFileSync(join(cache, 'environment'), 'utf8')).toBe('prod');
  });
});
