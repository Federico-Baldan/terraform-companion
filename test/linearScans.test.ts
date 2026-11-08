import { describe, expect, it } from 'vitest';
import { providerSourcesFromLockFile } from '../src/features/cacheCleaner';
import { calleeBefore } from '../src/features/countForEach';

/** The two patterns below read text that comes from the workspace, so a crafted
 *  or generated file picks how long the run they scan is. Both used to retry from
 *  every position of that run, which made the cost quadratic in its length: a
 *  100k-character word froze the extension host for 12s, and the same ran again
 *  on every cursor move. They are rewritten as a single pass, and these tests
 *  hold them to two things — the same answer as the patterns they replaced, and
 *  a cost that grows with the input rather than with its square. */

const OLD_COLLECTION_CALL = /([\w-]+)\s*\($/;
const OLD_LOCK_PROVIDER = /^\s*provider\s+"([^"]+)"\s*\{/gm;

/** Deterministic, so a failure names a string that can be replayed. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(next: () => number, alphabet: readonly string[], maxLen: number): string {
  const len = Math.floor(next() * (maxLen + 1));
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}

/** Generous on purpose: this guards the shape of the cost, not a benchmark. A
 *  single pass over 40k characters is well under a millisecond; the quadratic
 *  pattern needs seconds, so even a machine ten times slower tells them apart. */
const BUDGET_MS = 500;

describe('calleeBefore', () => {
  it('names the function whose first argument slot the text ends in', () => {
    expect(calleeBefore('x = length(')).toBe('length');
    expect(calleeBefore('x = length  (')).toBe('length');
    expect(calleeBefore('x = my-func_2(')).toBe('my-func_2');
    expect(calleeBefore('(')).toBeUndefined();
    expect(calleeBefore('')).toBeUndefined();
    expect(calleeBefore('length')).toBeUndefined();
    expect(calleeBefore('a = (')).toBeUndefined();
    expect(calleeBefore('f(x')).toBeUndefined();
  });

  it('answers what the pattern it replaced answered, on random text', () => {
    const next = rng(20260);
    const alphabet = ['a', 'Z', '9', '_', '-', ' ', '\t', '\n', '(', ')', 'é', '\u00a0', '\u2028'];
    for (let i = 0; i < 20_000; i++) {
      const text = randomString(next, alphabet, 14).trimEnd();
      expect(calleeBefore(text), JSON.stringify(text)).toBe(OLD_COLLECTION_CALL.exec(text)?.[1]);
    }
  });

  it('stays linear on one very long word', () => {
    const word = 'a'.repeat(40_000);
    const started = performance.now();
    expect(calleeBefore(word)).toBeUndefined();
    expect(calleeBefore(`${word}(`)).toBe(word);
    expect(calleeBefore(`${word}${' '.repeat(40_000)}(`)).toBe(word);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe('providerSourcesFromLockFile', () => {
  const lock = (body: string) => providerSourcesFromLockFile(body);

  it('reads the provider blocks of a lock file', () => {
    const text = [
      '# This file is maintained automatically by "terraform init".',
      'provider "registry.terraform.io/hashicorp/aws" {',
      '  version = "5.0.0"',
      '}',
      '',
      '  provider "registry.terraform.io/hashicorp/null"   {',
      '}',
      '\tprovider\t"registry.terraform.io/hashicorp/random"\n{',
      '}',
    ].join('\n');
    expect([...lock(text)].sort()).toEqual([
      'registry.terraform.io/hashicorp/aws',
      'registry.terraform.io/hashicorp/null',
      'registry.terraform.io/hashicorp/random',
    ]);
  });

  it('only reads a block that starts its line', () => {
    expect(lock('x provider "a/b/c" {\n}').size).toBe(0);
    expect(lock('# provider "a/b/c" {\n}').size).toBe(0);
  });

  it('answers what the pattern it replaced answered, on random text', () => {
    const next = rng(77);
    const fragments = [
      'provider "a/b/c" {',
      'provider "x/y/z"\n{',
      'provider',
      ' provider "q/r/s" {',
      '"',
      '{',
      '}',
      '\n',
      '\r\n',
      '\r',
      ' ',
      '\t',
      '\u00a0',
      '\f',
      '\u2028',
      '\ufeff',
      'x',
      '#',
    ];
    for (let i = 0; i < 20_000; i++) {
      const text = randomString(next, fragments, 12);
      const expected = [...text.matchAll(OLD_LOCK_PROVIDER)].map((m) => m[1]);
      expect([...providerSourcesFromLockFile(text)], JSON.stringify(text)).toEqual([
        ...new Set(expected),
      ]);
    }
  });

  /** The slow shape is a long run of blank lines followed by something that is
   *  not a provider block: `^\s*` crosses every blank line from each line start,
   *  finds no `provider` at the end of the run, and starts over one line later. A
   *  run that ends in a provider matches at once and never shows it. */
  it('stays linear on a file of blank lines that ends in something else', () => {
    const started = performance.now();
    expect([...lock(`provider "a/b/c" {\n}\n${'\n'.repeat(40_000)}x\n`)]).toEqual(['a/b/c']);
    expect(lock(`${'\r\n'.repeat(40_000)}x\n`).size).toBe(0);
    expect(lock(`${' \n'.repeat(40_000)}x\n`).size).toBe(0);
    expect(lock(`${'\t\n'.repeat(40_000)}# done`).size).toBe(0);
    // a lone \r ends a line for `^` too, and so does U+2028: a class that only
    // leaves out \n would still walk these runs from every line start
    expect(lock(`${'\r'.repeat(40_000)}x`).size).toBe(0);
    expect(lock(`${String.fromCharCode(0x2028).repeat(40_000)}x`).size).toBe(0);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
