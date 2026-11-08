import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { initTestParser } from './helpers';

beforeAll(initTestParser);

type Use = ReturnType<WorkspaceIndex['refsTo']>[number];

const key = (u: Use) =>
  `${u.file}:${u.ref.span.start.row}:${u.ref.span.start.column}:${u.ref.parts.join('.')}`;
const keys = (uses: Use[]) => uses.map(key).sort();

/** What every caller did before `refsToInDir` existed: fetch the workspace-wide
 *  bucket and filter it. The new method has to be indistinguishable from this. */
const viaFilter = (index: WorkspaceIndex, parts: string[], dir: string) =>
  index.refsTo(parts).filter((u) => index.moduleDirOf(u.file) === dir);

async function workspace(): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex();
  await index.updateFile(
    '/w/a/main.tf',
    'locals {\n  tags = {}\n  name = local.tags\n}\noutput "o" {\n  value = local.tags.x\n}\n',
  );
  await index.updateFile('/w/a/more.tf', 'output "p" {\n  value = local.tags\n}\n');
  await index.updateFile(
    '/w/b/main.tf',
    'locals {\n  tags = {}\n}\noutput "q" {\n  value = local.tags\n}\n',
  );
  await index.updateFile(
    '/w/b/res.tf',
    [
      'resource "aws_x" "y" {\n  id = aws_x.y.id\n}',
      'data "aws_ami" "z" {}',
      'output "d" {\n  value = data.aws_ami.z.id\n}',
      '',
    ].join('\n'),
  );
  await index.updateFile('/w/c/prod.tfvars', 'x = 1\n');
  return index;
}

describe('filesIn', () => {
  it('lists the .tf files of one directory: no subdirectories, no tfvars, none elsewhere', async () => {
    const index = await workspace();
    await index.updateFile('/w/a/terraform.tfvars', 'x = 1\n');
    await index.updateFile('/w/a/sub/deep.tf', 'locals {\n  d = 1\n}\n');
    const paths = (dir: string) =>
      index
        .filesIn(dir)
        .map((f) => f.path)
        .sort();
    expect(paths('/w/a')).toEqual(['/w/a/main.tf', '/w/a/more.tf']);
    expect(paths('/w/a/sub')).toEqual(['/w/a/sub/deep.tf']);
    expect(paths('/w/b')).toEqual(['/w/b/main.tf', '/w/b/res.tf']);
    // a directory holding only a tfvars is not a module
    expect(paths('/w/c')).toEqual([]);
    expect(paths('/nowhere')).toEqual([]);
  });

  it('hands back the indexed files themselves, in step with edits and removals', async () => {
    const index = await workspace();
    const before = index.filesIn('/w/a');
    expect(before.every((f) => f === index.file(f.path))).toBe(true);
    await index.updateFile('/w/a/more.tf', 'output "p" {\n  value = 2\n}\n');
    expect(index.filesIn('/w/a').find((f) => f.path === '/w/a/more.tf')).toBe(
      index.file('/w/a/more.tf'),
    );
    index.removeFile('/w/a/more.tf');
    expect(index.filesIn('/w/a').map((f) => f.path)).toEqual(['/w/a/main.tf']);
  });

  it('reads a directory spelled with backslashes as the index spells it', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('C:\\w\\a\\main.tf', 'locals {\n  a = 1\n}\n');
    expect(index.filesIn('C:\\w\\a')).toHaveLength(1);
    expect(index.filesIn('C:/w/a')).toHaveLength(1);
  });
});

describe('refsToInDir', () => {
  it('returns exactly the references in that directory, for a shared address', async () => {
    const index = await workspace();
    for (const dir of ['/w/a', '/w/b', '/w/c', '/w/missing']) {
      expect(keys(index.refsToInDir(['local', 'tags'], dir))).toEqual(
        keys(viaFilter(index, ['local', 'tags'], dir)),
      );
    }
    // and it is not vacuous: both directories really do reference it
    expect(index.refsToInDir(['local', 'tags'], '/w/a').length).toBe(3);
    expect(index.refsToInDir(['local', 'tags'], '/w/b').length).toBe(1);
  });

  /** Two ways to answer, picked by which side is smaller: walk the directory's
   *  files looking each up in the address's bucket, or walk the bucket's files
   *  keeping the ones in this directory. A flat directory of a thousand files
   *  asked about an address one file mentions must not pay a lookup per file —
   *  and the second way must still drop references that live in other
   *  directories. Both are compared against the plain filter here. */
  it('agrees with the filter whichever side is smaller', async () => {
    const index = new WorkspaceIndex();
    // many files in /big, only one of which names local.rare — and /other names
    // it too, so the bucket holds a reference the directory must not return
    for (let i = 0; i < 12; i++) {
      await index.updateFile(`/big/f${i}.tf`, `locals {\n  u${i} = 1\n}\n`);
    }
    await index.updateFile(
      '/big/f3.tf',
      'locals {\n  u3 = 1\n}\noutput "r" {\n  value = local.rare\n}\n',
    );
    await index.updateFile('/other/main.tf', 'output "r" {\n  value = local.rare\n}\n');
    // the bucket (2 files) is smaller than /big (12): the bucket is walked
    const rare = index.refsToInDir(['local', 'rare'], '/big');
    expect(rare.map((u) => u.file)).toEqual(['/big/f3.tf']);
    expect(keys(rare)).toEqual(keys(viaFilter(index, ['local', 'rare'], '/big')));
    expect(keys(index.refsToInDir(['local', 'rare'], '/other'))).toEqual(
      keys(viaFilter(index, ['local', 'rare'], '/other')),
    );
    // and when every file mentions it, the directory is the smaller side
    for (let i = 0; i < 12; i++) {
      await index.updateFile(`/big/f${i}.tf`, `output "o${i}" {\n  value = local.common\n}\n`);
    }
    await index.updateFile('/other/main.tf', 'output "r" {\n  value = local.common\n}\n');
    expect(index.refsToInDir(['local', 'common'], '/big')).toHaveLength(12);
    expect(keys(index.refsToInDir(['local', 'common'], '/big'))).toEqual(
      keys(viaFilter(index, ['local', 'common'], '/big')),
    );
    // a three-part address takes the same two branches and still narrows by parts
    await index.updateFile('/big/d.tf', 'output "d" {\n  value = data.aws_ami.z.id\n}\n');
    await index.updateFile('/other/d.tf', 'output "d" {\n  value = data.aws_ami.y.id\n}\n');
    expect(index.refsToInDir(['data', 'aws_ami', 'z'], '/big')).toHaveLength(1);
    expect(index.refsToInDir(['data', 'aws_ami', 'y'], '/big')).toEqual([]);
  });

  it('keeps the attribute path of the reference, as refsTo does', async () => {
    const index = await workspace();
    const parts = index.refsToInDir(['local', 'tags'], '/w/a').map((u) => u.ref.parts.join('.'));
    expect(parts.sort()).toEqual(['local.tags', 'local.tags', 'local.tags.x']);
  });

  it('matches refsTo for an address that is not in the two-part bucket', async () => {
    const index = await workspace();
    // a data source's address is three parts; the bucket only keys on two
    expect(keys(index.refsToInDir(['data', 'aws_ami', 'z'], '/w/b'))).toEqual(
      keys(viaFilter(index, ['data', 'aws_ami', 'z'], '/w/b')),
    );
    expect(index.refsToInDir(['data', 'aws_ami', 'z'], '/w/b')).toHaveLength(1);
    expect(index.refsToInDir(['data', 'aws_ami', 'z'], '/w/a')).toEqual([]);
    // a single part is a scan, exactly as refsTo does it
    expect(keys(index.refsToInDir(['local'], '/w/a'))).toEqual(
      keys(viaFilter(index, ['local'], '/w/a')),
    );
  });

  it('is empty for an address nothing references, and for a directory with no files', async () => {
    const index = await workspace();
    expect(index.refsToInDir(['local', 'nope'], '/w/a')).toEqual([]);
    expect(index.refsToInDir(['local', 'tags'], '/w/c')).toEqual([]);
    expect(index.refsToInDir(['local', 'tags'], '/nowhere')).toEqual([]);
  });

  it('stays in step with the index as files are edited and removed', async () => {
    const index = await workspace();
    // build the derived index first, so the writes below take the incremental path
    index.refsToInDir(['local', 'tags'], '/w/a');
    await index.updateFile('/w/a/more.tf', 'output "p" {\n  value = 1\n}\n');
    expect(keys(index.refsToInDir(['local', 'tags'], '/w/a'))).toEqual(
      keys(viaFilter(index, ['local', 'tags'], '/w/a')),
    );
    expect(index.refsToInDir(['local', 'tags'], '/w/a')).toHaveLength(2);

    index.removeFile('/w/a/main.tf');
    expect(index.refsToInDir(['local', 'tags'], '/w/a')).toEqual([]);
    expect(keys(index.refsToInDir(['local', 'tags'], '/w/b'))).toEqual(
      keys(viaFilter(index, ['local', 'tags'], '/w/b')),
    );

    await index.updateFile('/w/a/new.tf', 'output "n" {\n  value = local.tags\n}\n');
    expect(index.refsToInDir(['local', 'tags'], '/w/a')).toHaveLength(1);
  });

  it('reads a directory spelled with backslashes as the index spells it', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('C:\\w\\a\\main.tf', 'output "o" {\n  value = local.x\n}\n');
    expect(index.refsToInDir(['local', 'x'], 'C:\\w\\a')).toHaveLength(1);
    expect(index.refsToInDir(['local', 'x'], 'C:/w/a')).toHaveLength(1);
  });

  it('hands back a fresh array each time, so a caller cannot corrupt the index', async () => {
    const index = await workspace();
    const first = index.refsToInDir(['local', 'tags'], '/w/a');
    first.length = 0;
    expect(index.refsToInDir(['local', 'tags'], '/w/a')).toHaveLength(3);
  });
});
