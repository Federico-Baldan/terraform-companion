import * as vscode from 'vscode';
import { TrackedDirs } from './core/trackedDirs';
import { normalizePath, type WorkspaceIndex } from './core/workspaceIndex';
import { isExcludedTfPath, isTfPath, TF_EXCLUDE, TF_GLOB } from './vscodeUtils';

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
  /** Filesystem events that landed while the initial index was still being
   *  built, replayed once the watchers below are wired. See `activate`. */
  initialEvents: readonly { uri: vscode.Uri; deleted: boolean }[] = [],
): void {
  /** Both maps below are keyed by the *normalized* spelling of a path.
   *
   *  VS Code hands out `fsPath` with backslashes on Windows, while
   *  `index.pathsUnder()` returns normalized keys. Keying on the raw path made
   *  every lookup that crosses the two spellings miss: the nested-delete sweep
   *  could not find the timers it exists to cancel, so an armed debounce put a
   *  deleted file straight back into the index, and `supersede` wrote a second,
   *  unrelated epoch entry that guarded nothing. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped when a path's content is superseded. A disk read started before the
   *  bump compares its token after the await and drops its result. */
  const epoch = new Map<string, number>();
  const supersede = (path: string): number => {
    const key = normalizePath(path);
    const next = (epoch.get(key) ?? 0) + 1;
    epoch.set(key, next);
    return next;
  };
  const tokenOf = (path: string): number | undefined => epoch.get(normalizePath(path));
  const clearTimerFor = (path: string): void => {
    const key = normalizePath(path);
    const pending = timers.get(key);
    if (pending) {
      clearTimeout(pending);
      timers.delete(key);
    }
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
  /** Clearing the timers on dispose is not enough on its own. A disk read that
   *  started before the teardown resolves after it, and `announce` would then
   *  arm a *fresh* coalesce timer — `flushTimer` having just been cleared is
   *  precisely what makes it look idle — which fires onChanged into a disposed
   *  DiagnosticCollection. `set` on one throws, and nothing awaits a timer
   *  callback, so it surfaces as an unhandled extension-host error. */
  let disposed = false;
  const announce = (paths: readonly string[]): void => {
    if (disposed) return;
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
    clearTimerFor(path);
    timers.set(
      normalizePath(path),
      setTimeout(async () => {
        timers.delete(normalizePath(path));
        // the buffer is newer: an in-flight disk read must not land on top of it
        supersede(path);
        // Nothing awaits this callback, so a throw here lands on the extension
        // host as an unhandled rejection. The parser recurses over the CST
        // without a depth bound, so deeply nested HCL — a half-typed file with
        // runaway brackets is enough — raises RangeError, and it would do so on
        // every keystroke while the file stayed open.
        let changed: boolean;
        try {
          changed = await index.updateFile(path, doc.getText());
        } catch (e) {
          log?.(`Not indexed (parse failed): ${path}: ${e}`);
          return;
        }
        // Identical bytes are the common case here, not the exception: opening
        // a file, and typing a character then deleting it, both land on text the
        // index already holds. Announcing anyway re-lints every file in the
        // module directory and refreshes the CodeLens, which re-parses the whole
        // document with no memo — a full round of work to reproduce output that
        // cannot have changed.
        if (changed) announce([path]);
      }, DEBOUNCE_MS),
    );
  };

  /** Re-read a created/changed file from disk. Guards: the exclusion filter, an
   *  open dirty buffer (newer than disk, and the editor path owns it), and a
   *  file gone between the event and the read.
   *
   *  `ignoreDirtyOf` is the document being disposed on a close: it can still be
   *  listed in `textDocuments`, and letting its own dirty state veto the read is
   *  exactly backwards — its text is the text being discarded. */
  const refreshFromDisk = async (uri: vscode.Uri, ignoreDirtyOf?: vscode.TextDocument) => {
    if (disposed || isExcludedTfPath(uri.fsPath)) return;
    if (
      vscode.workspace.textDocuments.some(
        (d) => d !== ignoreDirtyOf && d.isDirty && d.uri.fsPath === uri.fsPath,
      )
    ) {
      return;
    }
    tracked.add(uri.fsPath);
    const token = supersede(uri.fsPath);
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      // A delete can land mid-read: the bytes still arrive, and writing them
      // would put the file back into the index after removeFile took it out.
      if (disposed || tokenOf(uri.fsPath) !== token) return;
      // a save makes this re-read what the 500ms buffer debounce already
      // parsed, so without the guard every save costs two full refresh rounds
      if (await index.updateFile(uri.fsPath, text)) announce([uri.fsPath]);
    } catch (e) {
      // unreadable or deleted right after the event — but a parse failure lands
      // here too, and reading that as a missing file hid it completely
      log?.(`Not indexed (unreadable, deleted, or parse failed): ${uri.fsPath}: ${e}`);
    }
  };

  /** Forget everything under a directory: armed timers, in-flight reads, and
   *  indexed files. Shared by the folder-delete watcher and workspace-folder
   *  removal, which differ only in how they learn the directory is gone — the
   *  sweeps themselves have to be identical, since either one leaving a timer
   *  armed puts a file straight back into the index after it was retracted. */
  const dropUnder = (dirPath: string): void => {
    const prefix = `${normalizePath(dirPath)}/`;
    for (const [key, timer] of timers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }
    for (const key of [...epoch.keys()]) {
      if (key.startsWith(prefix)) supersede(key);
    }
    const gone = index.pathsUnder(dirPath);
    if (gone.length === 0) return;
    for (const p of gone) index.removeFile(p);
    // routed through the same announce as every other retraction, so the lint
    // pipeline drops their diagnostics instead of leaving them in the Problems
    // panel for files that are no longer part of the workspace
    announce(gone);
  };

  /** Index the .tf files a newly added workspace folder already contains. */
  const indexFolder = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, TF_GLOB),
        TF_EXCLUDE,
      );
    } catch (e) {
      log?.(`Not indexed (scan failed): ${folder.uri.fsPath}: ${e}`);
      return;
    }
    if (disposed) return;
    // Every token is taken up front, before the first await — not one per
    // iteration inside it. `dropUnder` can only supersede a path that already
    // has an `epoch` entry, so taking them lazily left every file the loop had
    // not reached yet with nothing to supersede: removing the folder mid-scan
    // retracted only the part already indexed, and the scan then walked on and
    // re-inserted the rest. Those files stayed indexed for the whole session,
    // with diagnostics, for a folder no longer in the workspace.
    const tokens = new Map<string, number>();
    for (const uri of uris) {
      if (isExcludedTfPath(uri.fsPath)) continue;
      tracked.add(uri.fsPath);
      tokens.set(uri.fsPath, supersede(uri.fsPath));
    }
    const added: string[] = [];
    for (const uri of uris) {
      const token = tokens.get(uri.fsPath);
      if (token === undefined) continue;
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        // the folder can be removed again while this scan is still running
        if (disposed || tokenOf(uri.fsPath) !== token) continue;
        if (await index.updateFile(uri.fsPath, text)) added.push(uri.fsPath);
      } catch (e) {
        log?.(`Not indexed (unreadable or parse failed): ${uri.fsPath}: ${e}`);
      }
    }
    if (added.length > 0) announce(added);
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
      // The sweeps must run even when nothing under the folder is indexed yet:
      // an armed timer or an in-flight read would put a file back after removal.
      dropUnder(uri.fsPath);
    }),
  );
  context.subscriptions.push(
    {
      dispose: () => {
        disposed = true;
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        // a flush after deactivation would touch a disposed diagnostic
        // collection and a disposed status bar item
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingChanged.clear();
      },
    },
    // VS Code fires this with an empty change list for metadata-only events —
    // a dirty-state transition, an EOL/encoding/language-id change. The text is
    // identical by definition, so scheduling would only re-arm the debounce
    // (delaying a genuine pending edit) to end in a no-op re-index.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      scheduleRefresh(e.document);
    }),
    vscode.workspace.onDidOpenTextDocument((d) => scheduleRefresh(d)),
    // The debounce above pushes *dirty* buffer text into the index, so closing a
    // file without saving leaves the index — and every diagnostic, hover and
    // refactor-safety answer derived from it — on text that exists nowhere. The
    // file on disk never changed, so no watcher event ever corrects it and it
    // stays wrong for the rest of the session.
    //
    // Re-read unconditionally rather than only when the buffer was dirty: the
    // document is being disposed here, so its own `isDirty` is not something to
    // rely on, and a close is a rare user action whose read costs one `false`
    // from `updateFile` when the text already matched. Per the API docs this
    // also fires on a language-id change, where the document is not really
    // closing — reverting to disk is still correct there, and the matching open
    // event re-indexes the buffer.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      const path = doc.uri.fsPath;
      if (!isTfPath(path) || isExcludedTfPath(path)) return;
      if (!vscode.workspace.getWorkspaceFolder(doc.uri)) return;
      // an armed timer still holds the text that is being discarded
      clearTimerFor(path);
      void refreshFromDisk(doc.uri, doc);
    }),
    // Removing a folder from a multi-root workspace fires no filesystem event —
    // the files are still on disk — so nothing else ever retracted them. The
    // index kept every ParsedFile (its full source text with it), the Problems
    // panel kept diagnostics for files no longer in the workspace, and the next
    // settings change re-published them. Adding a folder is the mirror image:
    // the watchers cover it, but no create event fires for files already there,
    // so they stayed unindexed until opened one at a time — which silently
    // skews unused-local lints and module-call resolution in the meantime.
    //
    // Only the multi-root case needs handling: per the API docs this event does
    // not fire when the *first* folder is added or removed, because the
    // extension host is restarted instead.
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) dropUnder(folder.uri.fsPath);
      for (const folder of e.added) void indexFolder(folder);
    }),
    watcher,
    watcher.onDidCreate((uri) => void refreshFromDisk(uri)),
    // git pull, terraform fmt in a terminal, codegen: none of these pass through
    // onDidChangeTextDocument, so unopened files would keep their old content
    watcher.onDidChange((uri) => void refreshFromDisk(uri)),
    watcher.onDidDelete((uri) => handleDelete(uri)),
  );

  for (const e of initialEvents) {
    if (e.deleted) handleDelete(e.uri);
    else void refreshFromDisk(e.uri);
  }

  function handleDelete(uri: vscode.Uri): void {
    {
      // same exclusion as the create side: never indexed, so the removal is a
      // no-op and the refresh it triggers is waste
      if (isExcludedTfPath(uri.fsPath)) return;
      // An edit inside the debounce window leaves a timer armed with the
      // buffer's text; firing it after removeFile puts the file straight back.
      clearTimerFor(uri.fsPath);
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
        clearTimerFor(p);
        supersede(p);
      }
      index.removeFile(uri.fsPath);
      for (const p of nested) index.removeFile(p);
      announce([uri.fsPath, ...nested]);
    }
  }
}
