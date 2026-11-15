import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { registerIndexSync } from '../src/indexSync';
import { initTestParser } from './helpers';
import {
  FileType,
  fsMock,
  RelativePattern,
  resetVscodeMock,
  watchers,
  workspace,
} from './mocks/vscode';

beforeAll(initTestParser);
beforeEach(resetVscodeMock);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const TEXT = (path: string) => `locals {\n  from = "${path}"\n}\n`;

/** A disk the mock answers from, as the watcher leaves it after a directory was
 *  renamed, moved in or checked out: the files are there, and the only event is
 *  one `create` for the directory. Measured with the watcher VS Code ships, on
 *  Linux: `mv modules/vpc modules/network` reports `create modules/network` and
 *  `delete modules/vpc`, a directory moved into the workspace reports itself and
 *  nothing below, and a `git checkout` that adds nested directories reported 56
 *  of 130 new `.tf` files over ten runs. */
function disk(paths: string[]) {
  const files = new Set(paths);
  const calls = { stat: [] as string[], list: [] as string[], read: [] as string[] };
  fsMock.stat = async (fsPath) => {
    calls.stat.push(fsPath);
    if (files.has(fsPath)) return { type: FileType.File };
    if ([...files].some((f) => f.startsWith(`${fsPath}/`))) return { type: FileType.Directory };
    throw new Error('no file');
  };
  fsMock.findFiles = async (include) => {
    const under = include instanceof RelativePattern ? `${include.base.fsPath}/` : '/';
    calls.list.push(include instanceof RelativePattern ? include.base.fsPath : String(include));
    return [...files]
      .filter((f) => f.startsWith(under) && (f.endsWith('.tf') || f.endsWith('.tfvars')))
      .map((fsPath) => ({ fsPath, scheme: 'file' }));
  };
  fsMock.readFile = async (fsPath) => {
    calls.read.push(fsPath);
    if (!files.has(fsPath)) throw new Error('no file');
    return new TextEncoder().encode(TEXT(fsPath));
  };
  return { files, calls };
}

function start(index = new WorkspaceIndex()) {
  vi.useFakeTimers();
  const announced = new Set<string>();
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerIndexSync(context as never, index, (changed) => {
    for (const path of changed) announced.add(path);
  });
  const all = watchers.find((w) => w.pattern === '**');
  const tf = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
  if (!all || !tf) throw new Error('index sync registered no watcher');
  const settle = () => vi.advanceTimersByTimeAsync(15_000);
  return {
    index,
    announced,
    context,
    appear: (p: string) => all.fire('create', p),
    vanish: (p: string) => all.fire('delete', p),
    tf,
    settle,
  };
}

describe('a directory that appears with Terraform files already in it', () => {
  it('indexes the files of a renamed or moved-in directory', async () => {
    const { calls } = disk([
      '/ws/modules/network/main.tf',
      '/ws/modules/network/variables.tf',
      '/ws/modules/network/env/prod.tfvars',
      '/ws/modules/network/README.md',
    ]);
    const { index, announced, appear, settle } = start();

    appear('/ws/modules/network');
    await settle();

    expect(index.file('/ws/modules/network/main.tf')?.source).toBe(
      TEXT('/ws/modules/network/main.tf'),
    );
    expect(
      index
        .files()
        .map((f) => f.path)
        .sort(),
    ).toEqual([
      '/ws/modules/network/env/prod.tfvars',
      '/ws/modules/network/main.tf',
      '/ws/modules/network/variables.tf',
    ]);
    expect([...announced].sort()).toEqual([
      '/ws/modules/network/env/prod.tfvars',
      '/ws/modules/network/main.tf',
      '/ws/modules/network/variables.tf',
    ]);
    expect(calls.list).toEqual(['/ws/modules/network']);
  });

  it('lists a tree that appeared in one go once, from its top', async () => {
    const { calls } = disk(['/ws/stacks/prod/eu/main.tf', '/ws/stacks/prod/us/main.tf']);
    const { index, appear, settle } = start();

    // what a checkout reports of a new tree: some of its directories, in any order
    appear('/ws/stacks/prod/eu');
    appear('/ws/stacks');
    appear('/ws/stacks/prod');
    await settle();

    expect(index.files()).toHaveLength(2);
    expect(calls.stat).toEqual(['/ws/stacks']);
    expect(calls.list).toEqual(['/ws/stacks']);
  });

  it('does not read again a file the watcher reported itself', async () => {
    const { calls } = disk(['/ws/new/a.tf', '/ws/new/deep/b.tf']);
    const { index, appear, tf, settle } = start();

    appear('/ws/new');
    tf.fire('create', '/ws/new/a.tf');
    await settle();

    expect(index.files()).toHaveLength(2);
    expect(calls.read.sort()).toEqual(['/ws/new/a.tf', '/ws/new/deep/b.tf']);
  });

  it('lists nothing for a file that was created', async () => {
    const { calls } = disk(['/ws/notes.txt', '/ws/main.tf']);
    const { index, appear, settle } = start();

    appear('/ws/notes.txt');
    await settle();

    expect(calls.stat).toEqual(['/ws/notes.txt']);
    expect(calls.list).toEqual([]);
    expect(index.files()).toEqual([]);
  });

  it('asks nothing about a path that can hold no indexed file', async () => {
    const { calls } = disk([
      '/ws/m/.terraform/modules/vpc/main.tf',
      '/ws/node_modules/pkg/main.tf',
      '/ws/m/.terragrunt-cache/x/main.tf',
      '/ws/.git/refs/heads/main.tf/x',
    ]);
    const { index, appear, settle } = start();

    appear('/ws/m/.terraform');
    appear('/ws/m/.terraform/modules/vpc');
    appear('/ws/node_modules');
    appear('/ws/node_modules/pkg');
    appear('/ws/m/.terragrunt-cache/x');
    appear('/ws/.git');
    appear('/ws/.git/refs/heads/feature');
    // a Terraform file is the other watcher's to report
    appear('/ws/m/new.tf');
    await settle();

    expect(calls.stat).toEqual([]);
    expect(calls.list).toEqual([]);
    expect(index.files()).toEqual([]);
  });

  it('lists the workspace once when more paths appear than are worth asking about', async () => {
    const { calls } = disk(['/ws/deep/in/a/new/tree/main.tf', '/ws/known.tf']);
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/known.tf', TEXT('/ws/known.tf'));
    const { appear, settle } = start(index);

    // a build, or a checkout between distant branches
    for (let i = 0; i < 5_000; i++) appear(`/ws/out/obj${i}.o`);
    await settle();

    expect(calls.stat).toEqual([]);
    expect(calls.list).toEqual(['**/*.{tf,tfvars}']);
    expect(index.file('/ws/deep/in/a/new/tree/main.tf')).toBeDefined();
    // already indexed: listed, not read again
    expect(calls.read).toEqual(['/ws/deep/in/a/new/tree/main.tf']);
  });

  it('waits for a burst to end before it asks', async () => {
    const { calls } = disk(['/ws/a/main.tf', '/ws/b/main.tf']);
    const { appear } = start();

    appear('/ws/a');
    await vi.advanceTimersByTimeAsync(600);
    appear('/ws/b');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.stat).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.stat.sort()).toEqual(['/ws/a', '/ws/b']);
  });

  it('does not wait for ever on a stream of events that never pauses', async () => {
    const { calls } = disk(['/ws/a/main.tf']);
    const { index, appear } = start();

    appear('/ws/a');
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(500);
      appear(`/ws/tmp${i}`);
    }

    expect(calls.list).toContain('/ws/a');
    expect(index.file('/ws/a/main.tf')).toBeDefined();
  });

  it('lists the workspace once a minute at most while a build keeps creating paths', async () => {
    const { files, calls } = disk(['/ws/known.tf']);
    const { index, appear } = start();

    // five minutes of a build: 100 paths every half second, never a pause
    for (let tick = 0; tick < 600; tick++) {
      for (let i = 0; i < 100; i++) appear(`/ws/out/t${tick}/obj${i}.o`);
      // a checkout in the middle of it, of which the watcher reports nothing
      if (tick === 300) files.add('/ws/checked/out/main.tf');
      await vi.advanceTimersByTimeAsync(500);
    }

    // the first as soon as ever, then one a minute: not one every ten seconds
    expect(calls.list.length).toBeGreaterThanOrEqual(4);
    expect(calls.list.length).toBeLessThanOrEqual(5);
    expect(calls.stat).toEqual([]);
    expect(index.file('/ws/checked/out/main.tf')).toBeDefined();
  });

  it('still lists what a build created after its last listing, once the minute is over', async () => {
    const { files, calls } = disk(['/ws/known.tf']);
    const { index, appear } = start();

    for (let i = 0; i < 100; i++) appear(`/ws/out/a${i}.o`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.list).toHaveLength(1);

    // a second burst right behind the first, and then nothing more
    files.add('/ws/late/main.tf');
    for (let i = 0; i < 100; i++) appear(`/ws/out/b${i}.o`);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.list).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls.list).toHaveLength(2);
    expect(index.file('/ws/late/main.tf')).toBeDefined();
  });

  it('does not hold back a directory that appears right after the workspace was listed', async () => {
    const { files, calls } = disk(['/ws/known.tf']);
    const { index, appear } = start();

    for (let i = 0; i < 100; i++) appear(`/ws/out/a${i}.o`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.list).toHaveLength(1);

    files.add('/ws/modules/network/main.tf');
    appear('/ws/modules/network');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls.list).toEqual(['**/*.{tf,tfvars}', '/ws/modules/network']);
    expect(index.file('/ws/modules/network/main.tf')).toBeDefined();
  });

  it('asks nothing once the extension is disposed', async () => {
    const { calls } = disk(['/ws/a/main.tf']);
    const { index, appear, context, settle } = start();

    appear('/ws/a');
    for (const subscription of context.subscriptions) subscription.dispose();
    await settle();

    expect(calls.stat).toEqual([]);
    expect(index.files()).toEqual([]);
  });
});

describe('a listing that fails', () => {
  it('is logged, and does not cost the other directories theirs', async () => {
    const { calls } = disk(['/ws/a/main.tf', '/ws/b/main.tf']);
    const list = fsMock.findFiles;
    fsMock.findFiles = (include) =>
      include instanceof RelativePattern && include.base.fsPath === '/ws/a'
        ? Promise.reject(new Error('gone'))
        : list(include);
    vi.useFakeTimers();
    const index = new WorkspaceIndex();
    const messages: string[] = [];
    registerIndexSync(
      { subscriptions: [] } as never,
      index,
      () => {},
      (m) => messages.push(m),
    );
    const all = watchers.find((w) => w.pattern === '**');
    if (!all) throw new Error('index sync registered no watcher');

    all.fire('create', '/ws/a');
    all.fire('create', '/ws/b');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(calls.list).toEqual(['/ws/b']);
    expect(index.file('/ws/b/main.tf')).toBeDefined();
    expect(messages).toEqual(['Not indexed (scan failed): /ws/a: Error: gone']);
  });
});

/** Workspace folders as VS Code reports them. */
function openFolders(folders: string[]): void {
  vi.spyOn(workspace, 'getWorkspaceFolder').mockImplementation(((uri: { fsPath: string }) =>
    folders.some((f) => uri.fsPath === f || uri.fsPath.startsWith(`${f}/`))
      ? {}
      : undefined) as never);
}

/** git removes a directory its checkout emptied and makes it again for what the
 *  other branch holds there. The watcher was following the directory that went,
 *  so nothing written into the new one is reported: `git checkout` of a branch
 *  that renamed `modules/vpc` to `modules/network`, the only module, reports
 *  `delete modules/vpc` and `change modules`, and nothing else (measured with
 *  the watcher VS Code ships, on Linux). The one thing the events do say is
 *  where something indexed went from. */
describe('a directory whose indexed content was replaced', () => {
  it('lists the directory an indexed directory went from', async () => {
    openFolders(['/ws']);
    const { calls } = disk(['/ws/modules/network/main.tf']);
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/modules/vpc/main.tf', TEXT('/ws/modules/vpc/main.tf'));
    const { vanish, settle } = start(index);

    vanish('/ws/modules/vpc');
    await settle();

    expect(index.files().map((f) => f.path)).toEqual(['/ws/modules/network/main.tf']);
    expect(calls.list).toEqual(['/ws/modules']);
  });

  it('lists the directory an indexed file went from', async () => {
    openFolders(['/ws']);
    const { calls } = disk(['/ws/modules/network/main.tf']);
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/modules/all.tf', TEXT('/ws/modules/all.tf'));
    const { tf, settle } = start(index);

    tf.fire('delete', '/ws/modules/all.tf');
    await settle();

    expect(index.files().map((f) => f.path)).toEqual(['/ws/modules/network/main.tf']);
    expect(calls.list).toEqual(['/ws/modules']);
  });

  it('asks nothing when what went held nothing indexed', async () => {
    openFolders(['/ws']);
    const { calls } = disk(['/ws/main.tf']);
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/main.tf', TEXT('/ws/main.tf'));
    const { vanish, tf, settle } = start(index);

    vanish('/ws/dist');
    vanish('/ws/target/debug');
    tf.fire('delete', '/ws/never-indexed.tf');
    await settle();

    expect(calls.stat).toEqual([]);
    expect(calls.list).toEqual([]);
  });

  it('does not look outside the workspace when a workspace folder itself is deleted', async () => {
    openFolders(['/home/me/ws']);
    const { calls } = disk(['/home/me/other/main.tf']);
    const index = new WorkspaceIndex();
    await index.updateFile('/home/me/ws/main.tf', TEXT('/home/me/ws/main.tf'));
    const { vanish, settle } = start(index);

    vanish('/home/me/ws');
    await settle();

    expect(calls.stat).toEqual([]);
    expect(calls.list).toEqual([]);
    expect(index.files()).toEqual([]);
  });
});
