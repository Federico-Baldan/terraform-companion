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
