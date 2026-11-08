import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { registerIndexSync } from '../src/indexSync';
import { initTestParser } from './helpers';
import { fsMock, resetVscodeMock, watchers, workspace } from './mocks/vscode';

beforeAll(initTestParser);
beforeEach(resetVscodeMock);

/** What a `git checkout` or `terraform fmt -recursive` does to the watcher: one
 *  event per file, thousands at once. Each event used to start its own read the
 *  moment it arrived, so the number of reads in flight was the number of files
 *  that changed. */
const TEXT = (n: number) => `locals {\n  v${n} = ${n}\n}\n`;

interface Burst {
  reads: Map<string, number>;
  /** the most reads that were awaiting an answer at the same moment */
  peak: () => number;
}

/** Reads that take a turn of the event loop, as a round trip to the main thread
 *  does, and count how many overlap. */
function slowReads(): Burst {
  const reads = new Map<string, number>();
  let open = 0;
  let peak = 0;
  fsMock.readFile = async (fsPath) => {
    reads.set(fsPath, (reads.get(fsPath) ?? 0) + 1);
    open++;
    peak = Math.max(peak, open);
    await new Promise((resolve) => setImmediate(resolve));
    open--;
    const n = Number(/f(\d+)\.tf$/.exec(fsPath)?.[1] ?? 0);
    return new TextEncoder().encode(TEXT(n));
  };
  return { reads, peak: () => peak };
}

function start(index: WorkspaceIndex): { announced: Set<string> } {
  const announced = new Set<string>();
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerIndexSync(context as never, index, (changed) => {
    for (const path of changed) announced.add(path);
  });
  return { announced };
}

const path = (i: number) => `/burst/m${i % 10}/f${i}.tf`;

afterEach(() => {
  vi.useRealTimers();
});

describe('a burst of file-system events', () => {
  it('does not read more files at once than the initial scan does', async () => {
    const index = new WorkspaceIndex();
    const burst = slowReads();
    const { announced } = start(index);
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');

    for (let i = 0; i < 300; i++) watcher.fire('change', path(i));
    await vi.waitFor(() => expect(announced.size).toBe(300), { timeout: 5000 });

    expect(index.files()).toHaveLength(300);
    // the initial scan reads 24 at a time; a burst has no reason to read more
    expect(burst.peak()).toBeLessThanOrEqual(24);
  });

  it('reads a file once when several events name it', async () => {
    const index = new WorkspaceIndex();
    const burst = slowReads();
    const { announced } = start(index);
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');

    // an editor that writes a temp file and renames it reports a create and then a
    // change, and `terraform fmt` over a tree can report a path more than once
    for (let i = 0; i < 60; i++) {
      watcher.fire('create', path(i));
      watcher.fire('change', path(i));
      watcher.fire('change', path(i));
    }
    await vi.waitFor(() => expect(announced.size).toBe(60), { timeout: 5000 });

    // only the last of a path's events can end in an update, since each one
    // replaces the one before; the earlier two read a file for nothing
    expect([...burst.reads.values()].reduce((a, b) => a + b, 0)).toBe(60);
    expect(index.file(path(7))?.source).toBe(TEXT(7));
  });

  it('leaves a file to its buffer when the buffer went dirty while the read was waiting', async () => {
    const index = new WorkspaceIndex();
    const burst = slowReads();
    const { announced } = start(index);
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');

    for (let i = 0; i < 100; i++) watcher.fire('change', path(i));
    // the last of them is still queued when its file is opened and edited: from
    // here on the buffer, not the disk, is what the index is meant to follow
    workspace.textDocuments.push({ uri: { fsPath: path(99) }, isDirty: true });
    await vi.waitFor(() => expect(announced.size).toBe(99), { timeout: 5000 });

    expect(index.file(path(99))).toBeUndefined();
    expect(burst.reads.get(path(99)) ?? 0).toBe(0);
  });

  it('does not index a file that was deleted while its read was waiting its turn', async () => {
    const index = new WorkspaceIndex();
    const burst = slowReads();
    const { announced } = start(index);
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');

    for (let i = 0; i < 100; i++) watcher.fire('change', path(i));
    // the last of them is still queued behind the others when it is deleted
    watcher.fire('delete', path(99));
    await vi.waitFor(() => expect(announced.size).toBe(100), { timeout: 5000 });

    expect(index.file(path(99))).toBeUndefined();
    expect(index.files()).toHaveLength(99);
    // and nothing was read for it: the delete had already replaced that event
    expect(burst.reads.get(path(99)) ?? 0).toBe(0);
  });
});

describe('a read that fails', () => {
  it('gives its slot back, so the files behind it are still indexed', async () => {
    const index = new WorkspaceIndex();
    const { announced } = start(index);
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');
    const failing = 30;
    fsMock.readFile = async (fsPath) => {
      await new Promise((resolve) => setImmediate(resolve));
      const n = Number(/f(\d+)\.tf$/.exec(fsPath)?.[1] ?? 0);
      if (n < failing) throw new Error('EBUSY');
      return new TextEncoder().encode(TEXT(n));
    };

    // more failures than there are slots: every one of them has to free its own
    for (let i = 0; i < failing + 5; i++) watcher.fire('change', path(i));
    await vi.waitFor(() => expect(announced.size).toBe(5), { timeout: 5000 });

    expect(index.files()).toHaveLength(5);
  });
});

/** A read that never answers — a dead mount, a file system provider that lost its
 *  connection — used to hold up only itself. With the reads bounded, 24 of them
 *  would hold every later event in the queue for good, and the index would stop
 *  following the disk until the window reloaded. */
describe('a read that never comes back', () => {
  it('gives its slot up, so the files behind it are still indexed', async () => {
    vi.useFakeTimers();
    const index = new WorkspaceIndex();
    const { announced } = start(index);
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');
    const hung = 24;
    fsMock.readFile = (fsPath) => {
      const n = Number(/f(\d+)\.tf$/.exec(fsPath)?.[1] ?? 0);
      return n < hung
        ? new Promise<Uint8Array>(() => {})
        : Promise.resolve(new TextEncoder().encode(TEXT(n)));
    };

    for (let i = 0; i < hung + 3; i++) watcher.fire('change', path(i));
    // the first 24 hold every slot; the last three are waiting behind them
    await vi.advanceTimersByTimeAsync(1_000);
    expect(index.file(path(hung))).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(index.file(path(hung))?.source).toBe(TEXT(hung));
    expect(announced).toEqual(new Set([path(hung), path(hung + 1), path(hung + 2)]));
  });

  /** What comes back after the extension was torn down has nowhere to go: the
   *  output channel is disposed, and writing to a disposed channel throws — from a
   *  promise nothing awaits. */
  it('says nothing about a read that fails after the extension was disposed', async () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    const context = { subscriptions: [] as { dispose(): void }[] };
    registerIndexSync(
      context as never,
      new WorkspaceIndex(),
      () => {},
      (m) => messages.push(m),
    );
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');
    fsMock.readFile = () => new Promise<Uint8Array>(() => {});

    watcher.fire('change', path(1));
    await vi.advanceTimersByTimeAsync(1_000);
    for (const subscription of context.subscriptions) subscription.dispose();
    // the read is given up on only now, after the teardown
    await vi.advanceTimersByTimeAsync(60_000);

    expect(messages).toEqual([]);
  });
});
