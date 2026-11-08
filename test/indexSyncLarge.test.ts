import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { registerIndexSync } from '../src/indexSync';
import { initTestParser } from './helpers';
import { fsMock, resetVscodeMock, watchers } from './mocks/vscode';

beforeAll(initTestParser);
beforeEach(resetVscodeMock);

/** The parse limit, written out (see test/parseLimit.test.ts). */
const LIMIT = 1_048_576;
const over = (tag: string) => `# ${tag}${'x'.repeat(LIMIT)}\n`;
const SMALL = 'locals {\n  a = 1\n}\n';

/** A file that is not parsed changes what the editor does for its whole module
 *  and for nothing else the user can see, so the only place to say why is the
 *  output channel. Said once per file, not on every edit of it. */
describe('a file too large to parse', () => {
  function start() {
    const index = new WorkspaceIndex();
    const messages: string[] = [];
    const context = { subscriptions: [] as { dispose(): void }[] };
    registerIndexSync(
      context as never,
      index,
      () => {},
      (m) => messages.push(m),
    );
    const watcher = watchers.find((w) => w.pattern === '**/*.{tf,tfvars}');
    if (!watcher) throw new Error('index sync registered no file watcher');
    const served = new Map<string, string>();
    fsMock.readFile = async (fsPath) => new TextEncoder().encode(served.get(fsPath) ?? '');
    const change = async (path: string, text: string) => {
      served.set(path, text);
      watcher.fire('change', path);
      await expect.poll(() => index.file(path)?.source).toBe(text);
    };
    const notices = (path: string) =>
      messages.filter((m) => m.includes(path) && m.includes('larger than 1 MiB'));
    return { index, change, notices };
  }

  it('is named in the log, once however often it changes', async () => {
    const { index, change, notices } = start();
    await change('/big/a.tf', over('1'));
    expect(index.file('/big/a.tf')?.tooLarge).toBe(true);
    expect(notices('/big/a.tf')).toHaveLength(1);

    await change('/big/a.tf', over('2'));
    await change('/big/a.tf', over('3'));
    expect(notices('/big/a.tf')).toHaveLength(1);
  });

  it('is named separately from the next one', async () => {
    const { change, notices } = start();
    await change('/big/a.tf', over('1'));
    await change('/big/b.tf', over('2'));
    expect(notices('/big/a.tf')).toHaveLength(1);
    expect(notices('/big/b.tf')).toHaveLength(1);
  });

  it('is named again if it shrinks, is read, and grows past the limit again', async () => {
    const { index, change, notices } = start();
    await change('/big/a.tf', over('1'));
    await change('/big/a.tf', SMALL);
    expect(index.file('/big/a.tf')?.tooLarge).toBeUndefined();
    expect(notices('/big/a.tf')).toHaveLength(1);
    await change('/big/a.tf', over('2'));
    expect(notices('/big/a.tf')).toHaveLength(2);
  });

  it('says nothing about a file that parses', async () => {
    const { change, notices } = start();
    await change('/big/ok.tf', SMALL);
    expect(notices('/big/ok.tf')).toHaveLength(0);
  });
});
