import { attrOf, stripQuotes } from './hcl';
import type { ParsedFile, TfAttr, TfBlock, TfRef } from './model';
import { parseFile } from './parser';

export interface IndexHost {
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Live buffers parsed outside the index must apply this too, or path
 *  equality checks against indexed paths fail on Windows. */
export function normalizePath(p: string): string {
  return norm(p);
}

function dirOf(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  return i === -1 ? '.' : n.slice(0, i);
}

/** The leading part of an absolute base that `..` can never climb past.
 *
 *  POSIX spells that one way, Windows spells it two — a drive (`C:/…`) and a
 *  UNC share (`//server/share/…`) — and VS Code hands out both as `fsPath`. A
 *  plain `startsWith('/')` test reads a drive path as *relative*, so the root
 *  clamp below never fired: `C:/w` + `../../x` resolved to a bare `x`, which
 *  matches no indexed directory. The call site then looked uninstantiated, and
 *  the submodule's variables resolved from its own defaults instead of the
 *  caller's values — a confidently wrong hover, on Windows only.
 *
 *  Returned without a trailing slash, which is also how `dirOf` spells a root
 *  ('' for POSIX, 'C:' for a drive): the two have to agree or directory keys
 *  stop matching. */
function absoluteRootOf(base: string): string | undefined {
  const unc = base.match(/^\/\/[^/]+\/[^/]+/);
  if (unc?.[0]) return unc[0];
  const drive = base.match(/^[A-Za-z]:(?=\/|$)/);
  if (drive?.[0]) return drive[0];
  return base.startsWith('/') ? '' : undefined;
}

export function resolveRel(baseDir: string, rel: string): string {
  // resolveRel and dirOf must agree on one spelling per dir: dirOf keys
  // "modules/vpc", not "./modules/vpc", so "." segments get stripped.
  //
  // absoluteness is tracked apart from `parts`, not as a leading "" — inside
  // the array, popping past it with "../.." would lose the only record the
  // base was absolute, turning "/a" + "../../b" into "b" instead of "/b"
  const base = norm(baseDir);
  const root = absoluteRootOf(base);
  const isAbsolute = root !== undefined;
  const parts = base
    .slice(root?.length ?? 0)
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.');
  for (const seg of norm(rel).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // an absolute path cannot climb above its own root, but a relative one
      // has no root to stop at — above the base is simply outside the opened
      // folder, where a shared module legitimately lives. Dropping the extra
      // `..` collapsed that onto a real in-workspace dir and bound the call
      // site to the wrong module.
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!isAbsolute) parts.push('..');
    } else {
      parts.push(seg);
    }
  }
  // same agreement in reverse: an emptied relative parts joins to "", but
  // dirOf() calls that ".". An absolute base keeps its root marker, so empty
  // parts there already matches dirOf()
  if (parts.length > 0) return isAbsolute ? `${root}/${parts.join('/')}` : parts.join('/');
  // an absolute base emptied down to its root spells that root exactly as
  // dirOf() would: '' for POSIX, 'C:' for a drive, '//server/share' for a UNC
  return isAbsolute ? (root as string) : '.';
}

export function isLocalSource(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

export interface ModuleCallSite {
  /** file containing the module block */
  file: string;
  /** directory of that file, i.e. the module that makes the call */
  callerDir: string;
  block: TfBlock;
}

type ModuleCall = { file: string; callerDir: string; block: TfBlock; target?: string };

/** Per-directory lookups precomputed so the hot path doesn't rescan every file
 *  and block. Maintained incrementally: an edit retracts and re-adds only what
 *  the edited file contributed. */
interface DirIndex {
  variablesByDir: Map<string, Map<string, { file: string; block: TfBlock }>>;
  localsByDir: Map<string, { name: string; file: string; attr: TfAttr }[]>;
  /** every module block, keyed by the file declaring it, with its local source
   *  pre-resolved to a target dir. Keyed rather than flat so retracting one
   *  file's calls is O(1); iteration order still matches `parsed`, since an
   *  entry is written for every indexed .tf file and `Map.set` keeps a key's
   *  position. */
  moduleCallsByFile: Map<string, ModuleCall[]>;
  /** `moduleCallsByFile` flattened, rebuilt on demand. Dropped whenever a file's
   *  calls change; without it every `callSitesOf`/`modulesOf` re-flattened every
   *  module call in the workspace, which the hover path does per module dir. */
  flatCalls?: ModuleCall[];
  /** refs bucketed by their first two address parts — the alternative is a full
   *  scan per local/counted block on every refresh.
   *
   *  Order within a bucket is unspecified: an incremental update appends the
   *  edited file's refs rather than restoring them to that file's position in
   *  `parsed`. Every consumer asks whether a matching ref exists, never which
   *  came first; anything that starts caring must sort. */
  refsByAddress: Map<string, RefBucket>;
}

/** One address's references, grouped by the file that holds them.
 *
 *  Keyed by file for the same reason `moduleCallsByFile` is: retracting an
 *  edited file's entries is a `delete`, not a filter-and-reallocate of the whole
 *  bucket. Buckets are workspace-wide and keyed on only the first two address
 *  parts, so shared addresses collapse into one huge list — `each.value`,
 *  `count.index`, `var.tags`, and every data source of a provider type share a
 *  key. Rebuilding a 25k-entry array on every debounced keystroke, in a file
 *  that may not even mention the address, measured ~5x the cost of parsing the
 *  edited file, and it grew with the workspace while the edit stayed the size
 *  it was.
 *
 *  `flat` mirrors `flatCalls`: the flattened form, rebuilt on demand and
 *  dropped on any write, so the read path stays one array. */
interface RefBucket {
  byFile: Map<string, TfRef[]>;
  flat?: { file: string; ref: TfRef }[];
}

/** What one file contributes to the directory maps. `variable`, `locals` and
 *  `module` are declarations only at the top level of a file: a provider schema
 *  may define a nested block sharing one of those names, and reading it as a
 *  declaration invented locals the unused-locals lint then reported. */
function declarationsOf(f: ParsedFile): {
  variables: { name: string; block: TfBlock }[];
  locals: { name: string; file: string; attr: TfAttr }[];
  calls: ModuleCall[];
} {
  const dir = dirOf(f.path);
  const variables: { name: string; block: TfBlock }[] = [];
  const locals: { name: string; file: string; attr: TfAttr }[] = [];
  const calls: ModuleCall[] = [];
  for (const b of f.blocks) {
    if (b.kind === 'variable' && b.labels[0]) {
      variables.push({ name: b.labels[0], block: b });
    } else if (b.kind === 'locals') {
      for (const attr of b.attrs) locals.push({ name: attr.name, file: f.path, attr });
    } else if (b.kind === 'module') {
      const source = attrOf(b, 'source');
      const raw = source && stripQuotes(source.valueText);
      const target = raw && isLocalSource(raw) ? resolveRel(dir, raw) : undefined;
      calls.push({ file: f.path, callerDir: dir, block: b, target });
    }
  }
  return { variables, locals, calls };
}

export class WorkspaceIndex {
  private parsed = new Map<string, ParsedFile>();
  /** Indexed .tf paths grouped by directory, each list in `parsed` order.
   *  Rebuilding one directory is what keeps a shadowed declaration correct —
   *  two files in a directory can declare the same variable name, and dropping
   *  the edited file's entry alone would lose the other's. */
  private filesByDir = new Map<string, string[]>();
  private dirIndex?: DirIndex;
  private gen = 0;

  /** Index every file the host lists, skipping ones it can't read.
   *
   *  A read failure (deleted between listing and read, unreadable dir) says
   *  nothing about the workspace, but this build is awaited in `activate()`
   *  before providers register — letting it reject took every feature down. */
  static async build(
    host: IndexHost,
    onUnreadable?: (path: string, error: unknown) => void,
  ): Promise<WorkspaceIndex> {
    const index = new WorkspaceIndex();
    const files = await host.listFiles();
    // Reads overlap; parses still do not. Serially, file n+1's read did not
    // start until file n's read *and* parse had finished, so a 2000-file
    // workspace was 2000 sequential round trips across the ext-host RPC
    // boundary — 1-4s locally, 10-20s over Remote-SSH, WSL or a devcontainer —
    // and activate() awaits this before a single provider registers.
    //
    // Batched rather than a worker pool so the index is built in listing order,
    // byte for byte what the serial version produced: `files()` order feeds
    // diagnostic and candidate ordering. The bound also keeps a huge workspace
    // from opening a file descriptor per file.
    const CONCURRENCY = 24;
    for (let start = 0; start < files.length; start += CONCURRENCY) {
      const batch = files.slice(start, start + CONCURRENCY);
      const read = await Promise.all(
        batch.map(async (path): Promise<{ path: string; text?: string; error?: unknown }> => {
          try {
            return { path, text: await host.readFile(path) };
          } catch (error) {
            return { path, error };
          }
        }),
      );
      for (const r of read) {
        if (r.text === undefined) {
          onUnreadable?.(r.path, r.error);
          continue;
        }
        try {
          await index.updateFile(r.path, r.text);
        } catch (e) {
          // a parse failure, kept distinct from the read failure above
          onUnreadable?.(r.path, e);
        }
      }
    }
    return index;
  }

  /** Bumped on every content change, so cached derived results know when to
   *  invalidate. */
  generation(): number {
    return this.gen;
  }

  /** True when the index actually changed. Identical bytes return false so the
   *  sync layer can skip the announce: the wasted parse was never the expensive
   *  half — the announce re-lints the whole module directory and refreshes the
   *  CodeLens, which re-parses the document again with no memo, all to
   *  reproduce byte-identical output. */
  async updateFile(path: string, source: string): Promise<boolean> {
    const p = norm(path);
    // Identical bytes reach here constantly: a save makes the disk watcher
    // re-read what the 500ms debounce already parsed from the buffer, typing a
    // character and deleting it nets out to no change, and `terraform fmt
    // -recursive` over an already-formatted tree reports every file as changed.
    // The wasted parse is the smaller half — the invalidation below drops the
    // derived index for the *whole workspace*, which the next lint then rebuilds
    // from every block and ref in it.
    const previous = this.parsed.get(p);
    if (previous?.source === source) return false;
    const parsed = parseFile(p, source);
    this.parsed.set(p, parsed);
    if (!previous && p.endsWith('.tf')) {
      const list = this.filesByDir.get(dirOf(p));
      if (list) list.push(p);
      else this.filesByDir.set(dirOf(p), [p]);
    }
    // Incremental, not a full drop. Nulling `dirIndex` meant the next lint
    // rebuilt it from every block and every ref in the workspace — guaranteed
    // on every debounced keystroke, since the unused-locals memo is keyed on
    // the generation this bumps. On 2000 files that was ~10-30ms of blocked
    // extension host and 3-5MB of garbage per pause, re-deriving data for 1999
    // files that did not change.
    //
    // A .tfvars contributes nothing here (the build skips non-.tf files), so
    // its content change needs no index work at all — only the generation bump,
    // which the evaluator reads through `file()`.
    if (this.dirIndex && p.endsWith('.tf')) {
      if (previous) this.retractRefs(this.dirIndex, previous);
      this.rebuildDir(this.dirIndex, dirOf(p));
      this.addRefs(this.dirIndex, parsed);
    }
    this.gen++;
    return true;
  }

  removeFile(path: string): void {
    const p = norm(path);
    const previous = this.parsed.get(p);
    // the sync layer calls this for paths that were never indexed (an excluded
    // file, a directory); bumping the generation there invalidated every
    // generation-keyed memo for nothing
    if (!previous) return;
    this.parsed.delete(p);
    const dir = dirOf(p);
    const list = this.filesByDir.get(dir);
    if (list) {
      const at = list.indexOf(p);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.filesByDir.delete(dir);
    }
    if (this.dirIndex && p.endsWith('.tf')) {
      this.retractRefs(this.dirIndex, previous);
      this.dirIndex.moduleCallsByFile.delete(p);
      this.dirIndex.flatCalls = undefined;
      this.rebuildDir(this.dirIndex, dir);
    }
    this.gen++;
  }

  /** Recompute one directory's declarations from the files still in it. */
  private rebuildDir(idx: DirIndex, dir: string): void {
    const variables = new Map<string, { file: string; block: TfBlock }>();
    const locals: { name: string; file: string; attr: TfAttr }[] = [];
    for (const path of this.filesByDir.get(dir) ?? []) {
      const f = this.parsed.get(path);
      if (!f) continue;
      const decls = declarationsOf(f);
      // last declaration wins, exactly as a full pass in this order would
      for (const v of decls.variables) variables.set(v.name, { file: path, block: v.block });
      locals.push(...decls.locals);
      idx.moduleCallsByFile.set(path, decls.calls);
      idx.flatCalls = undefined;
    }
    if (variables.size > 0) idx.variablesByDir.set(dir, variables);
    else idx.variablesByDir.delete(dir);
    if (locals.length > 0) idx.localsByDir.set(dir, locals);
    else idx.localsByDir.delete(dir);
  }

  private addRefs(idx: DirIndex, f: ParsedFile): void {
    // grouped first so each address is written once, not once per reference
    const byKey = new Map<string, TfRef[]>();
    for (const ref of f.refs) {
      if (ref.parts.length < 2) continue;
      const key = `${ref.parts[0]}.${ref.parts[1]}`;
      const list = byKey.get(key);
      if (list) list.push(ref);
      else byKey.set(key, [ref]);
    }
    for (const [key, refs] of byKey) {
      const bucket = idx.refsByAddress.get(key);
      if (bucket) {
        bucket.byFile.set(f.path, refs);
        bucket.flat = undefined;
      } else {
        idx.refsByAddress.set(key, { byFile: new Map([[f.path, refs]]) });
      }
    }
  }

  /** Drop a file's entries from the buckets it contributed to. The previous
   *  `ParsedFile` is the record of which those were, so no separate bookkeeping
   *  can drift out of sync with it. */
  private retractRefs(idx: DirIndex, f: ParsedFile): void {
    const keys = new Set<string>();
    for (const ref of f.refs) {
      if (ref.parts.length >= 2) keys.add(`${ref.parts[0]}.${ref.parts[1]}`);
    }
    for (const key of keys) {
      const bucket = idx.refsByAddress.get(key);
      if (!bucket) continue;
      if (!bucket.byFile.delete(f.path)) continue;
      if (bucket.byFile.size === 0) idx.refsByAddress.delete(key);
      else bucket.flat = undefined;
    }
  }

  private idx(): DirIndex {
    if (this.dirIndex) return this.dirIndex;
    const built: DirIndex = {
      variablesByDir: new Map(),
      localsByDir: new Map(),
      moduleCallsByFile: new Map(),
      refsByAddress: new Map(),
    };
    // moduleCallsByFile is seeded in `parsed` order here, and `Map.set` keeps a
    // key's position afterwards, so later incremental writes never reorder it
    for (const f of this.parsed.values()) {
      if (!f.path.endsWith('.tf')) continue;
      built.moduleCallsByFile.set(f.path, []);
      this.addRefs(built, f);
    }
    for (const dir of this.filesByDir.keys()) this.rebuildDir(built, dir);
    this.dirIndex = built;
    return built;
  }

  private moduleCalls(): ModuleCall[] {
    const idx = this.idx();
    if (idx.flatCalls) return idx.flatCalls;
    const out: ModuleCall[] = [];
    for (const calls of idx.moduleCallsByFile.values()) out.push(...calls);
    idx.flatCalls = out;
    return out;
  }

  files(): ParsedFile[] {
    return [...this.parsed.values()];
  }

  file(path: string): ParsedFile | undefined {
    return this.parsed.get(norm(path));
  }

  moduleDirOf(file: string): string {
    return dirOf(file);
  }

  /** Whether any indexed file in this directory needed error recovery to parse.
   *
   *  `refs` is a floor, not the whole truth, whenever that happened: a file
   *  mid-edit yields *fewer* references than its text really contains. Anything
   *  that reads an absent reference as permission — the count→for_each rewrite
   *  above all — has to withhold instead, or an unterminated string two lines
   *  up in a sibling silently authorises a rewrite that breaks the config the
   *  moment the sibling parses again. */
  moduleHasParseError(moduleDir: string): boolean {
    const files = this.filesByDir.get(norm(moduleDir));
    return files?.some((p) => this.parsed.get(p)?.hasError) ?? false;
  }

  /** Indexed paths under a directory — VS Code fires one event for a folder
   *  delete, not per-file, so the sync layer asks what it covered. */
  pathsUnder(dirPath: string): string[] {
    const prefix = `${norm(dirPath)}/`;
    return [...this.parsed.keys()].filter((p) => p.startsWith(prefix));
  }

  /** All blocks of a kind (searched recursively) across .tf files, with their file path. */
  blocksByKind(kind: string): { file: string; block: TfBlock }[] {
    const out: { file: string; block: TfBlock }[] = [];
    const visit = (file: string, blocks: TfBlock[]) => {
      for (const b of blocks) {
        if (b.kind === kind) out.push({ file, block: b });
        visit(file, b.blocks);
      }
    };
    for (const f of this.parsed.values()) {
      if (f.path.endsWith('.tf')) visit(f.path, f.blocks);
    }
    return out;
  }

  /** References whose parts start with the given prefix, e.g. ["local","x"] matches local.x.y. */
  refsTo(parts: string[]): { file: string; ref: TfRef }[] {
    // copied on the way out — the scan branch below returns a fresh array, so
    // callers that sort/splice can't reach back into the index
    if (parts.length === 2) {
      const bucket = this.idx().refsByAddress.get(`${parts[0]}.${parts[1]}`);
      if (!bucket) return [];
      if (!bucket.flat) {
        const flat: { file: string; ref: TfRef }[] = [];
        for (const [file, refs] of bucket.byFile) {
          for (const ref of refs) flat.push({ file, ref });
        }
        bucket.flat = flat;
      }
      return [...bucket.flat];
    }
    const out: { file: string; ref: TfRef }[] = [];
    for (const f of this.parsed.values()) {
      if (!f.path.endsWith('.tf')) continue;
      for (const ref of f.refs) {
        if (parts.every((p, i) => ref.parts[i] === p)) out.push({ file: f.path, ref });
      }
    }
    return out;
  }

  address(block: TfBlock): string | undefined {
    switch (block.kind) {
      case 'resource':
        return block.labels.length >= 2 ? `${block.labels[0]}.${block.labels[1]}` : undefined;
      case 'data':
        return block.labels.length >= 2 ? `data.${block.labels[0]}.${block.labels[1]}` : undefined;
      case 'module':
        return block.labels[0] ? `module.${block.labels[0]}` : undefined;
      case 'variable':
        return block.labels[0] ? `var.${block.labels[0]}` : undefined;
      case 'output':
        return block.labels[0] ? `output.${block.labels[0]}` : undefined;
      default:
        return undefined;
    }
  }

  /** Local module directories declared from files inside rootDir, recursively. */
  modulesOf(rootDir: string): string[] {
    const moduleCalls = this.moduleCalls();
    const seen = new Set<string>();
    const queue = [norm(rootDir)];
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      for (const call of moduleCalls) {
        if (call.callerDir !== dir || call.target === undefined) continue;
        if (!seen.has(call.target)) {
          seen.add(call.target);
          queue.push(call.target);
        }
      }
    }
    return [...seen];
  }

  /** Variables declared in .tf files of a module directory, with their defining file. */
  variablesOf(moduleDir: string): Map<string, { file: string; block: TfBlock }> {
    // copied on the way out, like refsTo: the derived index is now mutated in
    // place rather than dropped on every change, so a caller mutating what it
    // was handed corrupts a directory until something edits that same
    // directory — the old full invalidation used to wipe the damage
    return new Map(this.idx().variablesByDir.get(norm(moduleDir)) ?? []);
  }

  /** Module blocks whose local source resolves to moduleDir (the places that instantiate it). */
  callSitesOf(moduleDir: string): ModuleCallSite[] {
    const target = norm(moduleDir);
    return this.moduleCalls()
      .filter((call) => call.target === target)
      .map(({ file, callerDir, block }) => ({ file, callerDir, block }));
  }

  /** Call sites that make moduleDir a *called* module — calls from its own
   *  tree (examples/, tests/) don't count. Every "root or called" check must
   *  use this filter, or the two disagree. */
  externalCallSitesOf(moduleDir: string): ModuleCallSite[] {
    const target = norm(moduleDir);
    return this.callSitesOf(target).filter((s) => !`${s.callerDir}/`.startsWith(`${target}/`));
  }

  /** All local definitions (locals-block attributes) in a module directory. */
  localsOf(moduleDir: string): { name: string; file: string; attr: TfAttr }[] {
    // copied for the same reason as variablesOf
    return [...(this.idx().localsByDir.get(norm(moduleDir)) ?? [])];
  }
}
