import { normalizePath } from './workspaceIndex';

/** Every ancestor directory of the paths a sync layer tracks, so "can deleting
 *  this folder have taken a tracked path with it?" is one set lookup instead of
 *  a scan of every tracked path.
 *
 *  A folder delete arrives as ONE event for the folder, so the sync layer has
 *  to answer that question per event — and the events are not rare: a watcher
 *  wide enough to see folder deletes also sees `git checkout`, `cargo build`
 *  and `rm -rf dist` remove tens of thousands of paths that hold nothing
 *  indexed. Answering by scanning is what made those a CPU spike.
 *
 *  The set is only ever grown, never pruned. A stale entry is a false positive
 *  and costs one wasted scan; a missing entry is a false negative and strands
 *  an index entry or an armed timer for a file that is already gone. Growth is
 *  bounded by the number of distinct directories holding .tf files, which is a
 *  workspace property, not a session-length one. */
export class TrackedDirs {
  private dirs = new Set<string>();

  /** Record the ancestor chain of `path`. Amortised O(1): a directory is only
   *  ever added together with its own ancestors, so meeting one already in the
   *  set means the rest of the climb is there too. */
  add(path: string): void {
    let dir = normalizePath(path);
    for (let cut = dir.lastIndexOf('/'); cut > 0; cut = dir.lastIndexOf('/')) {
      dir = dir.slice(0, cut);
      if (this.dirs.has(dir)) return;
      this.dirs.add(dir);
    }
  }

  /** Whether anything tracked could live under `dirPath`. False means the
   *  caller can skip its sweeps outright. */
  mayContain(dirPath: string): boolean {
    const n = normalizePath(dirPath);
    // a watcher event carries no trailing slash, but the ancestor chain is
    // stored without one either way — normalise so the two spellings can't miss
    return this.dirs.has(n.endsWith('/') ? n.slice(0, -1) : n);
  }
}
