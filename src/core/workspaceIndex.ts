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

export function resolveRel(baseDir: string, rel: string): string {
  // resolveRel and dirOf must agree on one spelling per dir: dirOf keys
  // "modules/vpc", not "./modules/vpc", so "." segments get stripped.
  //
  // absoluteness is tracked apart from `parts`, not as a leading "" — inside
  // the array, popping past it with "../.." would lose the only record the
  // base was absolute, turning "/a" + "../../b" into "b" instead of "/b"
  const base = norm(baseDir);
  const isAbsolute = base.startsWith('/');
  const parts = base.split('/').filter((seg) => seg !== '' && seg !== '.');
  for (const seg of norm(rel).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // an absolute path cannot climb above its own root
      if (parts.length > 0) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  // same agreement in reverse: an emptied relative parts joins to "", but
  // dirOf() calls that ".". An absolute base keeps its root marker, so empty
  // parts there already matches dirOf()
  if (parts.length > 0) return (isAbsolute ? '/' : '') + parts.join('/');
  return isAbsolute ? '' : '.';
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

/** Per-directory lookups precomputed in one pass so the hot path doesn't
 *  rescan every file and block. Invalidated on any file change. */
interface DirIndex {
  variablesByDir: Map<string, Map<string, { file: string; block: TfBlock }>>;
  localsByDir: Map<string, { name: string; file: string; attr: TfAttr }[]>;
  /** every module block, with its local source pre-resolved to a target dir */
  moduleCalls: { file: string; callerDir: string; block: TfBlock; target?: string }[];
  /** refs bucketed by their first two address parts — the alternative is a full
   *  scan per local/counted block on every refresh. */
  refsByAddress: Map<string, { file: string; ref: TfRef }[]>;
}

export class WorkspaceIndex {
  private parsed = new Map<string, ParsedFile>();
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
    for (const f of await host.listFiles()) {
      try {
        await index.updateFile(f, await host.readFile(f));
      } catch (e) {
        onUnreadable?.(f, e);
      }
    }
    return index;
  }

  /** Bumped on every content change, so cached derived results know when to
   *  invalidate. */
  generation(): number {
    return this.gen;
  }

  async updateFile(path: string, source: string): Promise<void> {
    this.parsed.set(norm(path), parseFile(norm(path), source));
    this.dirIndex = undefined;
    this.gen++;
  }

  removeFile(path: string): void {
    this.parsed.delete(norm(path));
    this.dirIndex = undefined;
    this.gen++;
  }

  private idx(): DirIndex {
    if (this.dirIndex) return this.dirIndex;
    const variablesByDir = new Map<string, Map<string, { file: string; block: TfBlock }>>();
    const localsByDir = new Map<string, { name: string; file: string; attr: TfAttr }[]>();
    const moduleCalls: DirIndex['moduleCalls'] = [];
    const visit = (file: string, dir: string, blocks: TfBlock[]) => {
      for (const b of blocks) {
        if (b.kind === 'variable' && b.labels[0]) {
          let byName = variablesByDir.get(dir);
          if (!byName) {
            byName = new Map();
            variablesByDir.set(dir, byName);
          }
          byName.set(b.labels[0], { file, block: b });
        } else if (b.kind === 'locals') {
          let locals = localsByDir.get(dir);
          if (!locals) {
            locals = [];
            localsByDir.set(dir, locals);
          }
          for (const attr of b.attrs) locals.push({ name: attr.name, file, attr });
        } else if (b.kind === 'module') {
          const source = attrOf(b, 'source');
          const raw = source && stripQuotes(source.valueText);
          const target = raw && isLocalSource(raw) ? resolveRel(dir, raw) : undefined;
          moduleCalls.push({ file, callerDir: dir, block: b, target });
        }
        visit(file, dir, b.blocks);
      }
    };
    const refsByAddress = new Map<string, { file: string; ref: TfRef }[]>();
    for (const f of this.parsed.values()) {
      if (!f.path.endsWith('.tf')) continue;
      visit(f.path, dirOf(f.path), f.blocks);
      for (const ref of f.refs) {
        if (ref.parts.length < 2) continue;
        const key = `${ref.parts[0]}.${ref.parts[1]}`;
        const bucket = refsByAddress.get(key);
        if (bucket) bucket.push({ file: f.path, ref });
        else refsByAddress.set(key, [{ file: f.path, ref }]);
      }
    }
    this.dirIndex = { variablesByDir, localsByDir, moduleCalls, refsByAddress };
    return this.dirIndex;
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
      return [...(this.idx().refsByAddress.get(`${parts[0]}.${parts[1]}`) ?? [])];
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
    const { moduleCalls } = this.idx();
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
    return this.idx().variablesByDir.get(norm(moduleDir)) ?? new Map();
  }

  /** Module blocks whose local source resolves to moduleDir (the places that instantiate it). */
  callSitesOf(moduleDir: string): ModuleCallSite[] {
    const target = norm(moduleDir);
    return this.idx()
      .moduleCalls.filter((call) => call.target === target)
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
    return this.idx().localsByDir.get(norm(moduleDir)) ?? [];
  }
}
