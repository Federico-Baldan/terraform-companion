import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { featureEnabled } from '../config';
import type { TfvarsValue } from '../core/evaluator';
import type { ParsedFile } from '../core/model';
import { parseFile } from '../core/parser';
import { normalizePath, type WorkspaceIndex } from '../core/workspaceIndex';
import { isExcludedTfPath } from '../vscodeUtils';
import {
  computeHover,
  readPins,
  relativeTo,
  type TfvarsCandidate,
  tfvarsCandidates,
  tfvarsChain,
  tfvarsValues,
} from './resolvedHover';

export const PICK_TFVARS_COMMAND = 'tfCompanion.pickTfvars';
const COPY_VALUE_COMMAND = 'tfCompanion.copyValue';
const STATE_KEY = 'tfCompanion.activeTfvars';
const RECENT_KEY = 'tfCompanion.recentTfvars';
const MAX_RECENT = 5;

/** Pinned tfvars living outside the indexed workspace — an `environments/`
 *  folder one level above the opened root is a normal layout, and the index
 *  only covers workspace folders. Parsed on demand and watched individually,
 *  so an edit from outside VS Code still moves the hover. */
export class ExternalTfvars {
  private cache = new Map<string, ParsedFile>();
  /** Paths known not to exist, or that failed to read. Without it a pin whose
   *  file was deleted (a branch switch) or is unreadable re-issued a `stat`,
   *  and on the unreadable path a failing `open` too, on *every* lookup — and
   *  a lookup happens once per variable, per hover, with no user-visible
   *  symptom to explain the syscall traffic. Cleared by the watcher. */
  private missing = new Map<string, number>();
  /** How long a miss is trusted before a fresh stat. The watcher clears it on
   *  create, but recovery cannot depend on that alone: a pin that becomes
   *  readable again without a content event (a chmod), or one whose watcher
   *  was registered while its parent directory did not exist, would otherwise
   *  stay remembered as missing for the whole session. One stat every few
   *  seconds per pin is nothing next to the one-per-variable-per-hover storm
   *  the cache exists to stop. */
  private static readonly MISS_TTL_MS = 5_000;
  private watchers = new Map<string, vscode.FileSystemWatcher>();
  /** Bumped whatever changes what a lookup would answer, so callers can cache
   *  derived values (see `ActiveTfvars.valuesFor`) and still see an edit made
   *  outside VS Code. */
  private rev = 0;

  revision(): number {
    return this.rev;
  }

  /** A remembered miss, still inside its TTL. Expiring one here is what lets a
   *  file that came back be noticed without a watcher event. */
  private isMissing(path: string): boolean {
    const at = this.missing.get(path);
    if (at === undefined) return false;
    if (Date.now() - at < ExternalTfvars.MISS_TTL_MS) return true;
    this.missing.delete(path);
    return false;
  }

  get(path: string): ParsedFile | undefined {
    const cached = this.cache.get(path);
    if (cached) return cached;
    if (this.isMissing(path)) return undefined;
    return this.load(path);
  }

  has(path: string): boolean {
    if (this.cache.has(path)) return true;
    const remembered = this.missing.has(path);
    if (this.isMissing(path)) return false;
    if (existsSync(path)) {
      // an expired miss that turns out to exist changes what a lookup answers,
      // and nothing else would tell a caller its cached values went stale
      if (remembered) this.rev++;
      return true;
    }
    this.missing.set(path, Date.now());
    // watched even though it is absent: createFileSystemWatcher is valid on a
    // path that does not exist yet, and onDidCreate is what un-caches the miss
    this.watch(path);
    return false;
  }

  private load(path: string): ParsedFile | undefined {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // deleted or unreadable — remembered, and dropped again by the watcher
      this.missing.set(path, Date.now());
      this.watch(path);
      return undefined;
    }
    const parsed = parseFile(normalizePath(path), text);
    this.cache.set(path, parsed);
    // it was remembered as missing and is readable again: same staleness
    // problem as in has()
    if (this.missing.delete(path)) this.rev++;
    this.watch(path);
    return parsed;
  }

  private watch(path: string): void {
    if (this.watchers.has(path)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path)),
    );
    const drop = () => {
      this.cache.delete(path);
      this.missing.delete(path);
      this.rev++;
    };
    watcher.onDidChange(drop);
    watcher.onDidDelete(drop);
    // a file that appears later must not stay remembered as missing
    watcher.onDidCreate(drop);
    this.watchers.set(path, watcher);
  }

  /** Drops paths no longer pinned anywhere, so watchers don't outlive their pin. */
  retain(paths: Set<string>): void {
    for (const [path, watcher] of this.watchers) {
      if (paths.has(path)) continue;
      watcher.dispose();
      this.watchers.delete(path);
      this.cache.delete(path);
      this.missing.delete(path);
      this.rev++;
    }
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    this.cache.clear();
    this.missing.clear();
    this.rev++;
  }
}

export class ActiveTfvars {
  readonly external = new ExternalTfvars();
  /** Bumped by set/clear: a pin lives in workspaceState and moves without the
   *  index generation changing, so nothing else would invalidate `valuesCache`. */
  private pinsRev = 0;
  private valuesCache = new Map<
    string,
    { gen: number; pins: number; ext: number; values: Map<string, TfvarsValue> }
  >();
  /** One entry per module directory ever hovered, each holding a merged tfvars
   *  map. Bounded by workspace shape rather than session length, but not by
   *  anything that shrinks — cleared wholesale at the cap instead of evicted,
   *  since an entry costs one cheap recompute to rebuild. */
  private static readonly MAX_VALUES_CACHE = 256;

  constructor(
    private context: vscode.ExtensionContext,
    private index: WorkspaceIndex,
    private statusBar: vscode.StatusBarItem,
  ) {}

  /** moduleDir → the file pinned for it. A pin models `-var-file`, so the file
   *  itself may live anywhere; what it applies to is the key, not its folder. */
  private pins(): Record<string, string> {
    return readPins(this.context.workspaceState.get(STATE_KEY), (p) => this.index.moduleDirOf(p));
  }

  /** The file pinned for a module, if it is still readable. */
  get(moduleDir: string): string | undefined {
    const pinned = this.pins()[moduleDir];
    if (!pinned) return undefined;
    return this.index.file(pinned) || this.external.has(pinned) ? pinned : undefined;
  }

  async set(moduleDir: string, path: string): Promise<void> {
    await this.context.workspaceState.update(STATE_KEY, { ...this.pins(), [moduleDir]: path });
    const recent = [path, ...this.recent().filter((p) => p !== path)].slice(0, MAX_RECENT);
    await this.context.workspaceState.update(RECENT_KEY, recent);
    this.syncExternal();
    this.updateStatusBar();
  }

  /** Clears one module's pin; it falls back to what Terraform auto-loads. */
  async clear(moduleDir: string): Promise<void> {
    const { [moduleDir]: _dropped, ...rest } = this.pins();
    await this.context.workspaceState.update(STATE_KEY, rest);
    this.syncExternal();
    this.updateStatusBar();
  }

  /** Recently pinned files, freshest first. Filtered on read, not on write:
   *  a cached .terraform sweep or a branch switch can delete one at any time. */
  recent(): string[] {
    const stored = this.context.workspaceState.get<string[]>(RECENT_KEY) ?? [];
    return stored.filter((p) => this.index.file(p) || existsSync(p));
  }

  private syncExternal(): void {
    this.pinsRev++;
    this.external.retain(new Set(Object.values(this.pins())));
  }

  /** The module the picker and status bar act on: the active .tf file's dir. */
  activeModuleDir(): string | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.uri.scheme !== 'file' || !doc.fileName.endsWith('.tf')) return undefined;
    return this.index.moduleDirOf(normalizePath(doc.fileName));
  }

  updateStatusBar(): void {
    const moduleDir = this.activeModuleDir();
    const pinned = moduleDir === undefined ? undefined : this.get(moduleDir);
    // pins are per-module now, so the bar reports the module you are looking at
    this.statusBar.text = pinned
      ? `$(symbol-variable) tfvars: ${basename(pinned)}`
      : '$(symbol-variable) tfvars: auto';
    this.statusBar.tooltip =
      pinned && moduleDir !== undefined
        ? `Terraform Companion: forcing ${relativeTo(moduleDir, pinned)} for ${moduleDir} (click to change)`
        : 'Terraform Companion: each root module resolves values from its own terraform.tfvars / *.auto.tfvars (click to override)';
    this.statusBar.command = PICK_TFVARS_COMMAND;
    this.statusBar.show();
  }

  tfvarsFor(moduleDir: string): string[] {
    return tfvarsChain(this.index, moduleDir, this.get(moduleDir));
  }

  /** Memoised per module directory.
   *
   *  The evaluator asks for this once per distinct `var.*` it resolves, so one
   *  hover over a local built from forty variables called it forty-one times —
   *  and each call re-read the pins, re-derived the tfvars chain through
   *  `externalCallSitesOf` (two allocations over every module call in the
   *  workspace), re-listed every indexed file to find the auto-loaded ones, and
   *  re-walked each tfvars file into a fresh Map. Measured at ~9.4ms of pure
   *  re-globbing per hover on a 1500-file index, per mouse-stop.
   *
   *  Keyed on everything an answer depends on: the index generation, the pin
   *  revision, and the external-file revision — that last one is what keeps an
   *  edit to a pinned out-of-workspace tfvars from serving a stale value. */
  valuesFor(moduleDir: string): ReadonlyMap<string, TfvarsValue> {
    const gen = this.index.generation();
    const ext = this.external.revision();
    const hit = this.valuesCache.get(moduleDir);
    if (hit && hit.gen === gen && hit.pins === this.pinsRev && hit.ext === ext) return hit.values;
    const merged = new Map<string, TfvarsValue>();
    for (const path of this.tfvarsFor(moduleDir)) {
      // a pin outside the workspace has no indexed file, only a parsed copy
      const file = this.index.file(path) ?? this.external.get(path);
      for (const [name, value] of tfvarsValues(file)) merged.set(name, value);
    }
    if (this.valuesCache.size >= ActiveTfvars.MAX_VALUES_CACHE) this.valuesCache.clear();
    this.valuesCache.set(moduleDir, { gen, pins: this.pinsRev, ext, values: merged });
    return merged;
  }
}

/** Sentinel for the "let Terraform decide" row — distinct from `undefined`,
 *  which means the user dismissed the picker. */
const AUTOMATIC = Symbol('automatic');

interface TfvarsPickItem extends vscode.QuickPickItem {
  pick?: string | typeof AUTOMATIC | 'browse';
}

function separator(label: string): TfvarsPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function itemsFor(
  active: ActiveTfvars,
  index: WorkspaceIndex,
  moduleDir: string,
): TfvarsPickItem[] {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => normalizePath(f.uri.fsPath));
  const { candidates, truncated } = tfvarsCandidates(index, moduleDir, roots);
  const shown = new Set(candidates.map((c) => c.path));
  const rows = (group: TfvarsCandidate['group']): TfvarsPickItem[] =>
    candidates
      .filter((c) => c.group === group)
      .map((c) => ({ label: c.label, description: c.path, pick: c.path }));

  const items: TfvarsPickItem[] = [
    {
      label: 'Automatic',
      description:
        "each root module uses its own terraform.tfvars / *.auto.tfvars — Terraform's own rule",
      pick: AUTOMATIC,
    },
  ];
  const inModule = rows('module');
  if (inModule.length > 0) items.push(separator('in this module'), ...inModule);
  const nearby = rows('nearby');
  if (nearby.length > 0) items.push(separator('nearby'), ...nearby);
  const recent = active.recent().filter((p) => !shown.has(p));
  if (recent.length > 0) {
    items.push(
      separator('recent'),
      ...recent.map((p) => ({ label: relativeTo(moduleDir, p), description: p, pick: p })),
    );
  }
  items.push(separator(''), {
    label: '$(folder-opened) Browse…',
    description: truncated
      ? 'more tfvars exist than fit this list — pick any file'
      : 'pick any tfvars file, including outside the workspace',
    // survives filtering, so it is reachable no matter what the user types
    alwaysShow: true,
    pick: 'browse',
  });
  return items;
}

async function browseForTfvars(moduleDir: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: vscode.Uri.file(moduleDir),
    filters: { 'Terraform variables': ['tfvars'] },
    openLabel: 'Use for this module',
    title: 'Select a .tfvars file',
  });
  const path = picked?.[0] ? normalizePath(picked[0].fsPath) : undefined;
  if (path === undefined) return undefined;
  if (isExcludedTfPath(path)) {
    // .terraform is a cache the cleaner deletes on a timer, and terraform init
    // rewrites it — a pin in there breaks without warning
    void vscode.window.showWarningMessage(
      'Terraform Companion: that file is inside .terraform or node_modules, which are generated caches. Pick a file you control.',
    );
    return undefined;
  }
  return path;
}

async function pickTfvars(
  active: ActiveTfvars,
  index: WorkspaceIndex,
  moduleDir: string,
): Promise<string | typeof AUTOMATIC | undefined> {
  const choice = await vscode.window.showQuickPick(itemsFor(active, index, moduleDir), {
    placeHolder: `tfvars used to resolve values in ${basename(moduleDir)}`,
    matchOnDescription: true,
  });
  if (!choice?.pick) return undefined;
  if (choice.pick === 'browse') return browseForTfvars(moduleDir);
  return choice.pick;
}

export function registerResolvedHover(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
): ActiveTfvars {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  const active = new ActiveTfvars(context, index, statusBar);
  active.updateStatusBar();

  /** The buffer's parse, memoised per revision.
   *
   *  A hover is requested on every mouse-stop — several a second while the
   *  pointer moves — and each one re-parsed the whole document with tree-sitter
   *  before anything checked whether the cursor was even on a reference: 183ms
   *  per hover on a 6k-line file, paid again on a comment line that shows
   *  nothing. One slot is enough, since VS Code hovers one document at a time,
   *  and `version` changes on every edit so it can never go stale. */
  let parseCache: { key: string; file: ParsedFile | undefined } | undefined;
  const parseCached = (document: vscode.TextDocument, path: string): ParsedFile | undefined => {
    const key = `${document.uri.toString()}@${document.version}`;
    if (parseCache?.key === key) return parseCache.file;
    let file: ParsedFile | undefined;
    try {
      file = parseFile(path, document.getText());
    } catch {
      // the parser recurses over the CST without a depth bound, so a half-typed
      // file with runaway brackets throws RangeError — and uncaught here it
      // took the hover down. The failure is cached like any other result, so a
      // broken revision costs one parse rather than one per mouse-stop.
      file = undefined;
    }
    parseCache = { key, file };
    return file;
  };

  context.subscriptions.push(
    statusBar,
    active.external,
    // a pin belongs to one module, so the bar has to follow the active editor
    vscode.window.onDidChangeActiveTextEditor(() => active.updateStatusBar()),
    vscode.commands.registerCommand(COPY_VALUE_COMMAND, async (value: string) => {
      await vscode.env.clipboard.writeText(value);
    }),
    vscode.commands.registerCommand(PICK_TFVARS_COMMAND, async () => {
      const moduleDir = active.activeModuleDir();
      if (moduleDir === undefined) {
        // a pin belongs to a module, and without an open .tf there is none
        void vscode.window.showInformationMessage(
          'Terraform Companion: open a .tf file to choose the tfvars for its module.',
        );
        return;
      }
      if (index.externalCallSitesOf(moduleDir).length > 0) {
        // pinning here would be accepted and then ignored by tfvarsFor
        void vscode.window.showInformationMessage(
          'Terraform Companion: this module is called by another one, so Terraform never reads tfvars for it — its values come from the call site.',
        );
        return;
      }
      const picked = await pickTfvars(active, index, moduleDir);
      if (picked === undefined) return;
      if (picked === AUTOMATIC) await active.clear(moduleDir);
      else await active.set(moduleDir, picked);
    }),
    // scheme 'file' — without it the filter matches every scheme, and the
    // hover would resolve the old side of a git diff against the current index
    vscode.languages.registerHoverProvider([{ scheme: 'file', pattern: '**/*.tf' }], {
      provideHover(document, position, token) {
        if (!featureEnabled('resolvedHover')) {
          return undefined;
        }
        // parse the live buffer — the index is debounced and would resolve the
        // wrong token right after a keystroke. Values still resolve *through*
        // the index, so a file it doesn't contain can only produce "unknown",
        // wrongly asserting "no default" over one right there in the file
        const path = normalizePath(document.uri.fsPath);
        if (!index.file(path)) return undefined;
        // VS Code cancels a hover as soon as the pointer moves off the position,
        // and dragging across a locals block fires and cancels one per stop.
        // Unobserved, every abandoned request still ran to completion.
        if (token.isCancellationRequested) return undefined;
        const file = parseCached(document, path);
        if (!file || token.isCancellationRequested) return undefined;
        const body = computeHover(
          file,
          { row: position.line, column: position.character },
          {
            index,
            tfvarsOf: (dir) => active.valuesFor(dir),
            copyCommand: COPY_VALUE_COMMAND,
          },
        );
        if (body === undefined) return undefined;
        const md = new vscode.MarkdownString(body);
        // trust only our own copy command — a crafted value must not invoke
        // an arbitrary VS Code command
        md.isTrusted = { enabledCommands: [COPY_VALUE_COMMAND] };
        return new vscode.Hover(md);
      },
    }),
  );
  return active;
}
