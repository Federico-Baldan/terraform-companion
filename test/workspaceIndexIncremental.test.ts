import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { initTestParser } from './helpers';

/** The derived directory index is maintained incrementally: an edit retracts
 *  and re-adds only what the edited file contributed, instead of dropping the
 *  whole thing and rebuilding it from every block and ref in the workspace.
 *
 *  That is the highest-risk shape of optimisation in this codebase — a missed
 *  retraction leaves a stale entry and produces a *wrong* diagnostic, e.g. a
 *  local that is used reported as unused, which is the direction that costs the
 *  user real work. So rather than assert a handful of cases, this drives random
 *  sequences of updates and deletes and asserts the incremental index answers
 *  every public query exactly as a from-scratch rebuild of the same files does.
 *
 *  The fixtures deliberately include the cases hand-written tests miss: two
 *  files in one directory declaring the same variable name (retracting one must
 *  not lose the other), the same local name twice, empty files, and an empty
 *  `locals {}` block. */

const DIRS = ['/w', '/w/mods/a', '/w/mods/b'];
const FILES = DIRS.flatMap((d) => [`${d}/f0.tf`, `${d}/f1.tf`, `${d}/f2.tf`, `${d}/vals.tfvars`]);

const SNIPPETS = [
  'variable "x" {\n  default = "one"\n}\n',
  // same name as the snippet above: a shadowed declaration across two files
  'variable "x" {\n  default = "two"\n}\nvariable "y" {}\n',
  'locals {\n  a = var.x\n  b = local.a\n}\n',
  // same local name declared in a second file of the directory
  'locals {\n  a = "dup"\n}\n',
  'module "m" {\n  source = "./mods/a"\n  name = var.x\n}\n',
  'module "m2" {\n  source = "../b"\n  other = local.b\n}\n',
  'output "o" {\n  value = local.a\n}\n',
  'resource "aws_instance" "web" {\n  count = length(var.x)\n  tags = { n = local.b }\n}\n',
  'data "aws_ami" "img" {\n  owners = [var.y, aws_instance.web[0].id]\n}\n',
  'locals {}\n',
  '',
  'x = "tfvars-value"\n',
];

const ADDRESSES = [
  ['local', 'a'],
  ['local', 'b'],
  ['var', 'x'],
  ['var', 'y'],
  ['aws_instance', 'web'],
  ['module', 'm'],
  ['data', 'aws_ami', 'img'],
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Every answer the index is asked for in production, in a comparable shape. */
function snapshot(idx: WorkspaceIndex): string {
  return JSON.stringify({
    files: idx.files().map((f) => f.path),
    dirs: DIRS.map((d) => ({
      d,
      // order-insensitive: a Map keyed by name
      variables: [...idx.variablesOf(d)].map(([n, v]) => `${n}=${v.file}`).sort(),
      // order-SENSITIVE: this feeds the order unused-locals diagnostics appear in
      locals: idx.localsOf(d).map((l) => `${l.name}@${l.file}#${l.attr.span.start.row}`),
      calls: idx
        .callSitesOf(d)
        .map((s) => `${s.file}|${s.callerDir}|${s.block.labels[0]}`)
        .sort(),
      external: idx
        .externalCallSitesOf(d)
        .map((s) => `${s.file}|${s.block.labels[0]}`)
        .sort(),
      modules: [...idx.modulesOf(d)].sort(),
    })),
    // buckets are consumed with .some()/.filter().length, so compared as a
    // multiset rather than a sequence
    refs: ADDRESSES.map((a) => ({
      a: a.join('.'),
      uses: idx
        .refsTo(a)
        .map(
          (u) =>
            `${u.file}#${u.ref.span.start.row}:${u.ref.span.start.column}=${u.ref.parts.join('.')}`,
        )
        .sort(),
    })),
  });
}

/** A fresh index holding exactly `contents`, built with no incremental step:
 *  nothing queries it until every file is in, so the first query does the full
 *  from-scratch pass. */
async function rebuilt(contents: Map<string, string>): Promise<WorkspaceIndex> {
  const fresh = new WorkspaceIndex();
  for (const [path, source] of contents) await fresh.updateFile(path, source);
  return fresh;
}

beforeAll(async () => {
  await initTestParser();
});

describe('the incremental directory index', () => {
  it('answers exactly as a from-scratch rebuild across random edit sequences', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const live = new WorkspaceIndex();
      const contents = new Map<string, string>();

      for (let step = 0; step < 60; step++) {
        const path = FILES[Math.floor(rand() * FILES.length)] as string;
        const remove = rand() < 0.3;
        if (remove) {
          live.removeFile(path);
          contents.delete(path);
        } else {
          const source = SNIPPETS[Math.floor(rand() * SNIPPETS.length)] as string;
          await live.updateFile(path, source);
          contents.set(path, source);
        }

        // force the derived index to exist, so the NEXT operation takes the
        // incremental path rather than a lazy first build
        const live_ = snapshot(live);
        const ref = snapshot(await rebuilt(contents));
        if (live_ !== ref) {
          throw new Error(
            `seed ${seed} step ${step} (${remove ? 'remove' : 'update'} ${path})\nincremental: ${live_}\nrebuilt:     ${ref}`,
          );
        }
      }
    }
  }, 120_000);

  it('keeps a shadowed variable when the file that overrode it is deleted', async () => {
    const idx = new WorkspaceIndex();
    await idx.updateFile('/w/a.tf', 'variable "x" {\n  default = "from-a"\n}\n');
    await idx.updateFile('/w/b.tf', 'variable "x" {\n  default = "from-b"\n}\n');
    expect(idx.variablesOf('/w').get('x')?.file).toBe('/w/b.tf');

    idx.removeFile('/w/b.tf');
    // the naive retraction — drop entries whose file is the edited one — would
    // leave the directory with no `x` at all
    expect(idx.variablesOf('/w').get('x')?.file).toBe('/w/a.tf');
  });

  it('drops a local from the ref buckets when its file is rewritten', async () => {
    const idx = new WorkspaceIndex();
    await idx.updateFile('/w/main.tf', 'locals {\n  a = 1\n}\n');
    await idx.updateFile('/w/use.tf', 'output "o" {\n  value = local.a\n}\n');
    expect(idx.refsTo(['local', 'a'])).toHaveLength(1);

    await idx.updateFile('/w/use.tf', 'output "o" {\n  value = "nothing"\n}\n');
    // a stale bucket entry here is exactly what makes an unused local look used
    expect(idx.refsTo(['local', 'a'])).toHaveLength(0);
  });

  it('does not bump the generation for a file it never indexed', async () => {
    const idx = new WorkspaceIndex();
    await idx.updateFile('/w/main.tf', 'locals {\n  a = 1\n}\n');
    const gen = idx.generation();
    idx.removeFile('/w/never-seen.tf');
    expect(idx.generation()).toBe(gen);
  });
});
