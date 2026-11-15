import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { registerIndexSync } from '../src/indexSync';
import { initTestParser } from './helpers';
import { resetVscodeMock, workspace } from './mocks/vscode';

beforeAll(initTestParser);
beforeEach(resetVscodeMock);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const DISK = 'locals {\n  a = 1\n}\n';
const BUFFER = 'locals {\n  a = 1\n  b = 2\n}\n';

function start(index: WorkspaceIndex): { announced: string[][] } {
  const announced: string[][] = [];
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerIndexSync(context as never, index, (changed) => announced.push([...changed].sort()));
  return { announced };
}

/** Workspace folders as VS Code reports them: a path belongs to the workspace
 *  when any folder still open contains it. */
function openFolders(folders: string[]): void {
  vi.spyOn(workspace, 'getWorkspaceFolder').mockImplementation(((uri: { fsPath: string }) =>
    folders.some((f) => uri.fsPath === f || uri.fsPath.startsWith(`${f}/`))
      ? {}
      : undefined) as never);
}

/** The index is built from disk, and `onDidOpenTextDocument` does not fire for a
 *  document that was open before the extension activated. A buffer restored
 *  dirty by hot exit therefore never reached the index: a disk event is left to
 *  the buffer ("the editor path owns it") and the editor path had never run, so
 *  the diagnostics drawn on that buffer were computed from the saved file — on
 *  the wrong lines — until the first keystroke in it. */
describe('a document that is already open when the sync starts', () => {
  const doc = (text: string, isDirty: boolean) =>
    ({
      uri: { fsPath: '/ws/m/main.tf', scheme: 'file' },
      isDirty,
      getText: () => text,
    }) as never;

  it('indexes the buffer of one with unsaved changes', async () => {
    vi.useFakeTimers();
    openFolders(['/ws']);
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/m/main.tf', DISK);
    workspace.textDocuments.push(doc(BUFFER, true));

    const { announced } = start(index);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(index.file('/ws/m/main.tf')?.source).toBe(BUFFER);
    expect(announced).toEqual([['/ws/m/main.tf']]);
  });

  it('leaves one without unsaved changes to the disk', async () => {
    vi.useFakeTimers();
    openFolders(['/ws']);
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/m/main.tf', DISK);
    // not reloaded yet after a change on disk: the watcher owns this one
    workspace.textDocuments.push(doc(BUFFER, false));

    const { announced } = start(index);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(index.file('/ws/m/main.tf')?.source).toBe(DISK);
    expect(announced).toEqual([]);
  });
});

/** VS Code allows workspace folders to nest: `/repo` and `/repo/infra` can both
 *  be open. Removing one of them fires no file event, so its files are swept
 *  out of the index — but the files the other folder still contains were swept
 *  with them, and nothing ever indexed them again: no diagnostics and no hover
 *  for files that are still in the workspace, for the rest of the session. */
describe('removing a workspace folder that overlaps another', () => {
  type FoldersChanged = (e: {
    added: { uri: { fsPath: string } }[];
    removed: { uri: { fsPath: string } }[];
  }) => void;

  async function setup(): Promise<{
    index: WorkspaceIndex;
    announced: string[][];
    remove: (folder: string, remaining: string[]) => Promise<void>;
  }> {
    vi.useFakeTimers();
    let fire: FoldersChanged | undefined;
    vi.spyOn(workspace, 'onDidChangeWorkspaceFolders').mockImplementation(((
      handler: FoldersChanged,
    ) => {
      fire = handler;
      return { dispose() {} };
    }) as never);
    const index = new WorkspaceIndex();
    await index.updateFile('/repo/main.tf', DISK);
    await index.updateFile('/repo/infra/vpc.tf', DISK);
    const { announced } = start(index);
    const remove = async (folder: string, remaining: string[]): Promise<void> => {
      openFolders(remaining);
      if (!fire) throw new Error('index sync does not listen for workspace folder changes');
      fire({ added: [], removed: [{ uri: { fsPath: folder } }] });
      await vi.advanceTimersByTimeAsync(1_000);
    };
    return { index, announced, remove };
  }

  it('keeps the files of an inner folder that the outer one still contains', async () => {
    const { index, announced, remove } = await setup();
    await remove('/repo/infra', ['/repo']);

    expect(index.file('/repo/infra/vpc.tf')?.source).toBe(DISK);
    expect(index.file('/repo/main.tf')?.source).toBe(DISK);
    expect(announced).toEqual([]);
  });

  it('keeps the files of an inner folder when the outer one is removed', async () => {
    const { index, announced, remove } = await setup();
    await remove('/repo', ['/repo/infra']);

    expect(index.file('/repo/infra/vpc.tf')?.source).toBe(DISK);
    expect(index.file('/repo/main.tf')).toBeUndefined();
    expect(announced).toEqual([['/repo/main.tf']]);
  });

  it('still drops everything under a folder no other folder contains', async () => {
    const { index, announced, remove } = await setup();
    await remove('/repo', []);

    expect(index.files()).toEqual([]);
    expect(announced).toEqual([['/repo/infra/vpc.tf', '/repo/main.tf']]);
  });
});
