import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { MAX_PARSE_CHARS } from './core/parser';
import { TrackedDirs } from './core/trackedDirs';
import { normalizePath, READ_CONCURRENCY, type WorkspaceIndex } from './core/workspaceIndex';
import { isExcludedTfPath, isTfPath, TF_EXCLUDE, TF_GLOB } from './vscodeUtils';

const DEBOUNCE_MS = 500;
/** How long one disk read may go unanswered before it is given up on and its slot
 *  freed. Reads are bounded (see `acquireRead`), so one that never returns — a
 *  dead mount, a file system provider that lost its connection — would otherwise
 *  hold its slot for good, and 24 of them would stop the index following the disk
 *  until a reload. Far past any read that is going to answer; one that does
 *  answer later is ignored, and the file is picked up by its next event. */
const READ_TIMEOUT_MS = 30_000;
/** How long a burst of index changes is allowed to gather before consumers are
 *  told. Short enough to stay invisible next to DEBOUNCE_MS, long enough that a
 *  git checkout's per-file watcher events land in one batch. */
const COALESCE_MS = 50;
/** How long after the last path appeared before the directories among them are
 *  listed (see `scanAppeared`). A checkout or a copy is still writing into a
 *  directory when the watcher reports it, and what it writes below a directory
 *  the watcher has not caught up with is never reported at all, so the listing
 *  has to come after the burst rather than at its first event. */
const APPEARED_QUIET_MS = 1_000;
/** The longest a path that appeared waits for that pause: a build that creates
 *  a file every half second for minutes must not hold back the directory a
 *  checkout added in the meantime. */
const APPEARED_MAX_WAIT_MS = 10_000;
/** Paths one burst may ask about one by one. Each is a round trip to learn
 *  whether it is a directory, and a build or a checkout between distant
 *  branches creates tens of thousands; past this the burst is answered by one
 *  listing of the workspace instead, which costs the same whatever its size. */
const MAX_APPEARED = 64;
/** The least time between two listings of the whole workspace. One costs what
 *  the listing at activation does, and it grows with the workspace, not with
 *  what appeared: measured with ripgrep, which is what answers it, 0.6 s of CPU
 *  for 300,000 files. A build that creates paths for minutes overflows
 *  MAX_APPEARED again and again, and without this it was listed every
 *  APPEARED_MAX_WAIT_MS for as long as the build ran. The first listing is not
 *  held back, so a checkout is indexed as soon as before; a second one right
 *  behind it waits, and what it would have found is found a minute later. */
const LIST_ALL_GAP_MS = 60_000;

/** What the output channel says about a file past the parse limit: the one place
 *  that can say why a module's lints went quiet. */
export function tooLargeNotice(path: string): string {
  return `Skipped (larger than ${MAX_PARSE_CHARS / 1_048_576} MiB, so it is not parsed): ${path}. Nothing in it is analysed, and lints that need the whole module stay quiet while it is there.`;
}

/** Inside a repository's `.git` directory, where every git command creates lock
 *  files and refs and no Terraform file is ever indexed. */
function isGitInternalPath(path: string): boolean {
  return normalizePath(path).includes('/.git/');
}

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
  /** Disk reads in flight, and the events waiting for one of the slots.
   *
   *  A `git checkout` or `terraform fmt -recursive` reports one event per file, and
   *  each started its own read on arrival, so a burst of 5000 files was 5000 round
   *  trips to the main thread at once, on a channel every other extension shares.
   *  The limit is the one the initial scan reads at, for the same reason. A slot
   *  passes straight to the next waiter on release, so `reading` never dips and a
   *  burst keeps every slot busy until it drains. */
  let reading = 0;
  const waiting: (() => void)[] = [];
  const acquireRead = (): Promise<void> => {
    if (reading < READ_CONCURRENCY) {
      reading++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const releaseRead = (): void => {
    const next = waiting.shift();
    if (next) next();
    else reading--;
  };
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

  /** Every path into the index goes through here, so a file past the parse limit
   *  is named in the log by whichever of them finds it. Said when a file turns
   *  too large, not on every edit while it stays so: the state before the update
   *  is the memory, which also means a file deleted and brought back is named
   *  again, as is one that shrinks and grows past the limit a second time. */
  const updateIndex = async (path: string, text: string): Promise<boolean> => {
    const wasTooLarge = index.file(path)?.tooLarge === true;
    const changed = await index.updateFile(path, text);
    // after the teardown the output channel is gone, and writing to it throws
    if (!disposed && !wasTooLarge && index.file(path)?.tooLarge) log?.(tooLargeNotice(path));
    return changed;
  };
  // the files the initial scan found are named once, here
  for (const file of index.files()) if (file.tooLarge) log?.(tooLargeNotice(file.path));

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
          changed = await updateIndex(path, doc.getText());
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
  const readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      let read: Thenable<Uint8Array>;
      try {
        read = vscode.workspace.fs.readFile(uri);
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`no answer after ${READ_TIMEOUT_MS / 1000}s`)),
        READ_TIMEOUT_MS,
      );
      read.then(
        (bytes) => {
          clearTimeout(timer);
          resolve(bytes);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  const hasDirtyBuffer = (uri: vscode.Uri, ignoreDirtyOf?: vscode.TextDocument): boolean =>
    vscode.workspace.textDocuments.some(
      (d) => d !== ignoreDirtyOf && d.isDirty && d.uri.fsPath === uri.fsPath,
    );
  const refreshFromDisk = async (uri: vscode.Uri, ignoreDirtyOf?: vscode.TextDocument) => {
    if (disposed || isExcludedTfPath(uri.fsPath)) return;
    if (hasDirtyBuffer(uri, ignoreDirtyOf)) return;
    tracked.add(uri.fsPath);
    const token = supersede(uri.fsPath);
    await acquireRead();
    try {
      // Replaced while it waited for a slot: a later event for this path, a
      // delete or a buffer edit owns it now, and whatever was read here would be
      // dropped by the check below. Events for one path come in twos and threes
      // (an editor's temp file and rename, a formatter touching a file twice), so
      // this is most of what a burst would otherwise read for nothing.
      //
      // The dirty check is made again for the same reason: it was true to the
      // moment of the event, and the wait can be seconds long. An edit only takes
      // the path over once its debounce fires, so a buffer opened and typed into
      // meanwhile would have the disk's text written over what the index follows.
      if (disposed || tokenOf(uri.fsPath) !== token || hasDirtyBuffer(uri, ignoreDirtyOf)) return;
      const text = new TextDecoder().decode(await readFile(uri));
      // A delete can land mid-read: the bytes still arrive, and writing them
      // would put the file back into the index after removeFile took it out.
      if (disposed || tokenOf(uri.fsPath) !== token) return;
      // a save makes this re-read what the 500ms buffer debounce already
      // parsed, so without the guard every save costs two full refresh rounds
      if (await updateIndex(uri.fsPath, text)) announce([uri.fsPath]);
    } catch (e) {
      // After the teardown the output channel is gone, and writing to it throws
      // from a promise nothing awaits. A read given up on late lands here too.
      if (disposed) return;
      // Nothing on disk, and this read is still the last word on the path: what
      // the index holds for it can then only be a buffer that has been closed
      // (typed into after its file was deleted, or never saved at all), and no
      // event is left to retract it. Only for a file that is not there: one
      // that could not be read keeps what the index had, as before.
      if (
        (e as { code?: unknown } | undefined)?.code === 'FileNotFound' &&
        tokenOf(uri.fsPath) === token &&
        !hasDirtyBuffer(uri, ignoreDirtyOf) &&
        index.file(uri.fsPath)
      ) {
        index.removeFile(uri.fsPath);
        announce([uri.fsPath]);
        return;
      }
      // unreadable or deleted right after the event — but a parse failure lands
      // here too, and reading that as a missing file hid it completely
      log?.(`Not indexed (unreadable, deleted, or parse failed): ${uri.fsPath}: ${e}`);
    } finally {
      releaseRead();
    }
  };

  /** Forget everything under a directory: armed timers, in-flight reads, and
   *  indexed files. Shared by the folder-delete watcher and workspace-folder
   *  removal, which differ only in how they learn the directory is gone — the
   *  sweeps themselves have to be identical, since either one leaving a timer
   *  armed puts a file straight back into the index after it was retracted.
   *
   *  `keep` exempts paths that are under the directory and still not gone: see
   *  the workspace-folder handler, the one caller with any. */
  const dropUnder = (dirPath: string, keep?: (path: string) => boolean): void => {
    const prefix = `${normalizePath(dirPath)}/`;
    const goes = (key: string): boolean => key.startsWith(prefix) && !keep?.(key);
    for (const [key, timer] of timers) {
      if (goes(key)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }
    for (const key of [...epoch.keys()]) {
      if (goes(key)) supersede(key);
    }
    const gone = index.pathsUnder(dirPath).filter((p) => !keep?.(p));
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
    // No open event fires for a document that was open before the folder was
    // added, the same as at activation (see the end of `registerIndexSync`):
    // one with unsaved changes is the editor path's, so it is handed to it here
    // and left out of the reads below, which would write the disk's text over
    // the buffer the diagnostics are drawn on. A file from outside the
    // workspace joins the index this way, and with folders nesting it may have
    // been indexed, from its buffer, all along.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty) scheduleRefresh(doc);
    }
    // Every token is taken up front, before the first await — not one per
    // iteration inside it. `dropUnder` can only supersede a path that already
    // has an `epoch` entry, so taking them lazily left every file the loop had
    // not reached yet with nothing to supersede: removing the folder mid-scan
    // retracted only the part already indexed, and the scan then walked on and
    // re-inserted the rest. Those files stayed indexed for the whole session,
    // with diagnostics, for a folder no longer in the workspace.
    const tokens = new Map<string, number>();
    for (const uri of uris) {
      if (isExcludedTfPath(uri.fsPath) || hasDirtyBuffer(uri)) continue;
      tracked.add(uri.fsPath);
      tokens.set(uri.fsPath, supersede(uri.fsPath));
    }
    const added: string[] = [];
    for (const uri of uris) {
      const token = tokens.get(uri.fsPath);
      if (token === undefined) continue;
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        // the folder can be removed again while this scan is still running, and
        // a buffer typed into meanwhile owns its path once it is dirty
        if (disposed || tokenOf(uri.fsPath) !== token || hasDirtyBuffer(uri)) continue;
        if (await updateIndex(uri.fsPath, text)) added.push(uri.fsPath);
      } catch (e) {
        log?.(`Not indexed (unreadable or parse failed): ${uri.fsPath}: ${e}`);
      }
    }
    if (added.length > 0) announce(added);
  };

  /** Paths that appeared and may be directories, by normalized path. */
  const appeared = new Map<string, vscode.Uri>();
  /** More appeared than `appeared` holds; see MAX_APPEARED. */
  let appearedOverflow = false;
  let appearedTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the oldest path still waiting appeared, and when the newest did. */
  let appearedSince = 0;
  let appearedLast = 0;
  /** When the whole workspace was last listed; see LIST_ALL_GAP_MS. */
  let listedAllAt = Number.NEGATIVE_INFINITY;

  /** Index the Terraform files of the directories that appeared.
   *
   *  A directory that is renamed, moved into the workspace or restored from the
   *  trash arrives as ONE create event, for the directory: nothing is reported
   *  for the files in it. A tree that is written quickly, as `git checkout` and
   *  `git pull` write one, is not reported in full either: on Linux the watcher
   *  only starts watching a new directory once it has seen it appear, and what
   *  was created inside before that is lost (measured with the watcher VS Code
   *  ships: over ten checkouts of a branch adding four directories, 74 of 130
   *  new `.tf` files were never reported). Those files stayed out of the index
   *  until each was opened: a local used only from one of them was reported as
   *  unused, a variable declared in one resolved to nothing, and a reference
   *  from one did not hold back the count -> for_each rewrite.
   *
   *  So a directory that appears is listed, and each Terraform file in it that
   *  the index does not hold yet is read exactly as if its create event had
   *  arrived. The listing is the one the initial scan and a new workspace
   *  folder use, with the same exclusions, so it can only add what a reload of
   *  the window would. */
  const scanAppeared = async (): Promise<void> => {
    const batch = [...appeared];
    const everything = appearedOverflow;
    appeared.clear();
    appearedOverflow = false;
    /** what to list: directories, or `undefined` for the whole workspace */
    const bases: (vscode.Uri | undefined)[] = [];
    if (everything) {
      bases.push(undefined);
      listedAllAt = Date.now();
    } else {
      for (const [path, uri] of batch) {
        // a tree that appeared in one go is one listing, from its top
        if (batch.some(([other]) => path.startsWith(`${other}/`))) continue;
        try {
          const { type } = await vscode.workspace.fs.stat(uri);
          if ((type & vscode.FileType.Directory) !== 0) bases.push(uri);
        } catch {
          // gone again already: a temporary file, a lock
        }
      }
    }
    for (const base of bases) {
      // Nothing awaits this function: it runs off a timer, so a rejection would
      // land on the extension host as an unhandled one. Caught per directory,
      // so one that is gone again does not cost the others their listing.
      try {
        const uris = await vscode.workspace.findFiles(
          base ? new vscode.RelativePattern(base, TF_GLOB) : TF_GLOB,
          TF_EXCLUDE,
        );
        if (disposed) return;
        for (const uri of uris) {
          // already held: reported by its own event, or there all along
          if (isExcludedTfPath(uri.fsPath) || index.file(uri.fsPath)) continue;
          void refreshFromDisk(uri);
        }
      } catch (e) {
        // after the teardown the output channel is gone, and writing to it throws
        if (disposed) return;
        log?.(`Not indexed (scan failed): ${base?.fsPath ?? 'the workspace'}: ${e}`);
      }
    }
    // counted from its end as well: one that took long is not followed at once
    if (everything) listedAllAt = Date.now();
  };

  /** The timer of `noteAppeared`: lists once the burst has paused, or has gone
   *  on for long enough, and otherwise waits out what is left of the pause. */
  const appearedDue = (): void => {
    appearedTimer = undefined;
    if (disposed) return;
    const now = Date.now();
    const quietFor = now - appearedLast;
    if (quietFor < APPEARED_QUIET_MS && now - appearedSince < APPEARED_MAX_WAIT_MS) {
      appearedTimer = setTimeout(appearedDue, APPEARED_QUIET_MS - quietFor);
      return;
    }
    // Too many to ask about, so the workspace is what gets listed, and it was
    // listed a moment ago: wait out the rest of the gap. The timer stays armed,
    // so what appears meanwhile is only noted, and that listing covers it all.
    const held = appearedOverflow ? listedAllAt + LIST_ALL_GAP_MS - now : 0;
    if (held > 0) {
      appearedTimer = setTimeout(appearedDue, held);
      return;
    }
    void scanAppeared();
  };

  /** A few assignments per event, because it runs for every path created
   *  anywhere in the workspace and a build writes tens of thousands: the timer
   *  is armed once per burst rather than moved by every event, and the
   *  questions that cost something are asked once, in `scanAppeared`. */
  const noteAppeared = (uri: vscode.Uri): void => {
    if (disposed) return;
    if (appeared.size < MAX_APPEARED) appeared.set(normalizePath(uri.fsPath), uri);
    else appearedOverflow = true;
    appearedLast = Date.now();
    if (appearedTimer) return;
    appearedSince = appearedLast;
    appearedTimer = setTimeout(appearedDue, APPEARED_QUIET_MS);
  };

  /** Something indexed went from the directory it was in, which is then listed
   *  like one that appeared.
   *
   *  git removes a directory its checkout emptied and makes it again for what
   *  the other branch holds there, and the watcher was following the one that
   *  went: nothing written into the new one is reported. A checkout that renames
   *  the only module from `modules/vpc` to `modules/network` reports `delete
   *  modules/vpc` and nothing for `modules/network` or the file in it (measured
   *  with the watcher VS Code ships, on Linux). What the events do say is where
   *  something indexed went from, and what replaced it is beside it. */
  const noteGone = (uri: vscode.Uri): void => {
    const parent = vscode.Uri.file(dirname(uri.fsPath));
    // a workspace folder itself went: what is beside it is not in the workspace
    if (!vscode.workspace.getWorkspaceFolder(parent)) return;
    noteAppeared(parent);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(TF_GLOB);
  // Deleting a folder arrives as ONE event for the folder path — an Explorer
  // delete is a move to trash, so the per-file deletes TF_GLOB waits for never
  // fire. The folder path matches no file glob, so seeing it needs a second
  // watcher on everything. A folder that appears is the same in reverse (see
  // `scanAppeared`), so it listens for creates too; changes it has no use for.
  const folderWatcher = vscode.workspace.createFileSystemWatcher('**', false, true, false);
  context.subscriptions.push(
    folderWatcher,
    folderWatcher.onDidCreate((uri) => {
      // a matching file: the TF_GLOB create handler below owns that case
      if (isTfPath(uri.fsPath)) return;
      // nothing under these is ever indexed, and `npm install`, `terraform init`
      // and every git command create paths there
      if (isExcludedTfPath(`${uri.fsPath}/`) || isGitInternalPath(`${uri.fsPath}/`)) return;
      noteAppeared(uri);
    }),
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
      noteGone(uri);
    }),
  );
  context.subscriptions.push(
    {
      dispose: () => {
        disposed = true;
        // events still waiting for a read slot: each would only wake to find the
        // flag above and leave, and until then keeps its uri alive
        waiting.length = 0;
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        // a flush after deactivation would touch a disposed diagnostic
        // collection and a disposed status bar item
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingChanged.clear();
        if (appearedTimer) clearTimeout(appearedTimer);
        appearedTimer = undefined;
        appeared.clear();
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
    //
    // Folders may nest — `/repo` and `/repo/infra` can both be open — so a file
    // under the removed folder can still belong to one that stays. Sweeping it
    // too left it unindexed for the rest of the session: it is still on disk, so
    // no event ever brings it back. By the time this fires the folder list is
    // the new one, which makes `getWorkspaceFolder` the test for "still here",
    // the same one `scheduleRefresh` admits a file by.
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      const stillInWorkspace = (path: string): boolean =>
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path)) !== undefined;
      for (const folder of e.removed) dropUnder(folder.uri.fsPath, stillInWorkspace);
      for (const folder of e.added) void indexFolder(folder);
    }),
    watcher,
    watcher.onDidCreate((uri) => void refreshFromDisk(uri)),
    // git pull, terraform fmt in a terminal, codegen: none of these pass through
    // onDidChangeTextDocument, so unopened files would keep their old content
    watcher.onDidChange((uri) => void refreshFromDisk(uri)),
    watcher.onDidDelete((uri) => handleDelete(uri)),
  );

  // The index was built from disk, and no open event fires for a document that
  // was open before the listeners above existed: one restored with unsaved
  // changes by hot exit, or typed into while the initial scan was still
  // running. Its buffer is what the editor shows and what a disk event defers
  // to (`hasDirtyBuffer`), so without this the index — and the diagnostics
  // drawn on that buffer — stayed on the saved text until the next keystroke.
  // Only dirty ones: a clean buffer is the disk's text, which the scan read.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty) scheduleRefresh(doc);
  }

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
      // asked before it is removed below: only something indexed is worth a look
      if (index.file(uri.fsPath) || nested.length > 0) noteGone(uri);
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
