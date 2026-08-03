import * as vscode from 'vscode';
import { TrackedDirs } from './core/trackedDirs';
import { normalizePath, type WorkspaceIndex } from './core/workspaceIndex';
import { isExcludedTfPath, isTfPath, TF_GLOB } from './vscodeUtils';

const DEBOUNCE_MS = 500;
/** How long a burst of index changes is allowed to gather before consumers are
 *  told. Short enough to stay invisible next to DEBOUNCE_MS, long enough that a
 *  git checkout's per-file watcher events land in one batch. */
const COALESCE_MS = 50;

/**
 * Keeps the workspace index in sync with the editor: re-parses on edit
 * (debounced) and on file create/delete, then notifies the consumers.
 */
export function registerIndexSync(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  /** paths whose indexed content just changed, so consumers recompute only what
   *  those reach instead of the whole workspace */
  onChanged: (changed: string[]) => void,
  log?: (m: string) => void,
): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped when a path's content is superseded. A disk read started before the
   *  bump compares its token after the await and drops its result. */
  const epoch = new Map<string, number>();
  const supersede = (path: string): number => {
    const next = (epoch.get(path) ?? 0) + 1;
    epoch.set(path, next);
    return next;
  };
  /** Ancestors of every path the three maps above can hold. Seeded from the
   *  initial scan, then extended as timers arm and disk reads start, so it
   *  always covers the index, `timers` and `epoch` together — the exact set the
   *  folder-delete handler has to sweep. */
  const tracked = new TrackedDirs();
  for (const file of index.files()) tracked.add(file.path);

  /** Changed paths waiting to be announced.
   *
   *  A burst — git checkout, git pull, `terraform fmt -recursive`, codegen —
   *  reaches the watcher as one event per file, and announcing each one
   *  separately makes every consumer redo workspace-wide work: the index drops
   *  its whole derived directory map on any change, so the next lint rebuilds
   *  it from every block and ref in the workspace. Per file that is O(files);
   *  across a burst it was O(files²), which is the difference between a pull
   *  costing milliseconds and costing a minute of pegged extension host.
   *
   *  Collapsing to one announcement per burst keeps consumers unchanged — they
   *  already take a list — and a Set also drops the duplicate a save produces,
   *  where the buffer debounce and the disk watcher both report the same path. */
  const pendingChanged = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const announce = (paths: readonly string[]): void => {
    for (const p of paths) pendingChanged.add(p);
    if (flushTimer || pendingChanged.size === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      const batch = [...pendingChanged];
      pendingChanged.clear();
      onChanged(batch);
    }, COALESCE_MS);
  };
  const scheduleRefresh = (doc: vscode.TextDocument) => {
    // open/change fire for virtual docs too (a git diff of a .tf, a search
    // preview), and their fsPath is the real file's — writing getText() would
    // clobber the indexed file with the diff's *old* content. Only file-backed
    // buffers are the source of truth the watcher and providers already assume.
    if (doc.uri.scheme !== 'file') return;
    const path = doc.uri.fsPath;
    if (!isTfPath(path) || isExcludedTfPath(path)) return;
    // a .tf opened from outside the workspace must not join (and stay in) the index
    if (!vscode.workspace.getWorkspaceFolder(doc.uri)) return;
    tracked.add(path);
    const pending = timers.get(path);
    if (pending) clearTimeout(pending);
    timers.set(
      path,
      setTimeout(async () => {
        timers.delete(path);
        // the buffer is newer: an in-flight disk read must not land on top of it
        supersede(path);
        // Nothing awaits this callback, so a throw here lands on the extension
        // host as an unhandled rejection. The parser recurses over the CST
        // without a depth bound, so deeply nested HCL — a half-typed file with
        // runaway brackets is enough — raises RangeError, and it would do so on
        // every keystroke while the file stayed open.
        try {
          await index.updateFile(path, doc.getText());
        } catch (e) {
          log?.(`Not indexed (parse failed): ${path}: ${e}`);
          return;
        }
        announce([path]);
      }, DEBOUNCE_MS),
    );
  };

  /** Re-read a created/changed file from disk. Guards: the exclusion filter, an
   *  open dirty buffer (newer than disk, and the editor path owns it), and a
   *  file gone between the event and the read. */
  const refreshFromDisk = async (uri: vscode.Uri) => {
    if (isExcludedTfPath(uri.fsPath)) return;
    if (vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === uri.fsPath)) {
      return;
    }
    tracked.add(uri.fsPath);
    const token = supersede(uri.fsPath);
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      // A delete can land mid-read: the bytes still arrive, and writing them
      // would put the file back into the index after removeFile took it out.
      if (epoch.get(uri.fsPath) !== token) return;
      await index.updateFile(uri.fsPath, text);
      announce([uri.fsPath]);
    } catch (e) {
      // unreadable or deleted right after the event — but a parse failure lands
      // here too, and reading that as a missing file hid it completely
      log?.(`Not indexed (unreadable, deleted, or parse failed): ${uri.fsPath}: ${e}`);
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher(TF_GLOB);
  // Deleting a folder arrives as ONE event for the folder path — an Explorer
  // delete is a move to trash, so the per-file deletes TF_GLOB waits for never
  // fire. The folder path matches no file glob, so seeing it needs a second
  // watcher on everything, deletes only.
  const folderWatcher = vscode.workspace.createFileSystemWatcher('**', true, true, false);
  context.subscriptions.push(
    folderWatcher,
    folderWatcher.onDidDelete((uri) => {
      // a matching file: the TF_GLOB delete handler below owns that case
      if (isTfPath(uri.fsPath)) return;
      // npm install / terraform init delete thousands of never-indexed paths
      if (isExcludedTfPath(`${uri.fsPath}/`)) return;
      // Everything below is O(tracked paths), and this handler runs for every
      // path removed anywhere in the workspace that the exclusions above don't
      // cover — a branch switch, a `cargo build`, an `rm -rf dist`. Those hold
      // nothing indexed, so the three sweeps found nothing and cost seconds of
      // blocked extension host per operation. This is the O(1) way to ask.
      if (!tracked.mayContain(uri.fsPath)) return;
      const prefix = `${normalizePath(uri.fsPath)}/`;
      // Both must run even when nothing under the folder is indexed yet: an
      // armed timer or an in-flight read would put a file back after the removal.
      for (const [key, timer] of timers) {
        if (normalizePath(key).startsWith(prefix)) {
          clearTimeout(timer);
          timers.delete(key);
        }
      }
      for (const key of [...epoch.keys()]) {
        if (normalizePath(key).startsWith(prefix)) supersede(key);
      }
      const gone = index.pathsUnder(uri.fsPath);
      if (gone.length === 0) return;
      for (const p of gone) index.removeFile(p);
      announce(gone);
    }),
  );
  context.subscriptions.push(
    {
      dispose: () => {
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        // a flush after deactivation would touch a disposed diagnostic
        // collection and a disposed status bar item
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingChanged.clear();
      },
    },
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.workspace.onDidOpenTextDocument((d) => scheduleRefresh(d)),
    watcher,
    watcher.onDidCreate((uri) => void refreshFromDisk(uri)),
    // git pull, terraform fmt in a terminal, codegen: none of these pass through
    // onDidChangeTextDocument, so unopened files would keep their old content
    watcher.onDidChange((uri) => void refreshFromDisk(uri)),
    watcher.onDidDelete((uri) => {
      // same exclusion as the create side: never indexed, so the removal is a
      // no-op and the refresh it triggers is waste
      if (isExcludedTfPath(uri.fsPath)) return;
      // An edit inside the debounce window leaves a timer armed with the
      // buffer's text; firing it after removeFile puts the file straight back.
      const pending = timers.get(uri.fsPath);
      if (pending) {
        clearTimeout(pending);
        timers.delete(uri.fsPath);
      }
      // and invalidate any disk read still in flight, for the same reason
      supersede(uri.fsPath);
      // This glob also matches a *directory* named like a .tf file — legal, if
      // unusual — and removeFile is a no-op for one, since files are keyed
      // individually. Sweeping pathsUnder() covers it, and is why folderWatcher
      // steps aside for isTfPath. A no-op for an ordinary single-file delete.
      //
      // Which is the point of the guard: an ordinary .tf file is never an
      // ancestor of anything, so the scan is skipped outright, while a
      // directory named `foo.tf` holding indexed files is in the set and still
      // gets swept. Deleting a folder of 1000 .tf files used to be 1000 full
      // passes over the index.
      const nested = tracked.mayContain(uri.fsPath) ? index.pathsUnder(uri.fsPath) : [];
      for (const p of nested) {
        const t = timers.get(p);
        if (t) {
          clearTimeout(t);
          timers.delete(p);
        }
        supersede(p);
      }
      index.removeFile(uri.fsPath);
      for (const p of nested) index.removeFile(p);
      announce([uri.fsPath, ...nested]);
    }),
  );
}
