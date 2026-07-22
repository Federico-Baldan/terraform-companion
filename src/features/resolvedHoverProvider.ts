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
  private watchers = new Map<string, vscode.FileSystemWatcher>();

  get(path: string): ParsedFile | undefined {
    const cached = this.cache.get(path);
    if (cached) return cached;
    return this.load(path);
  }

  has(path: string): boolean {
    return this.cache.has(path) || existsSync(path);
  }

  private load(path: string): ParsedFile | undefined {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return undefined; // deleted or unreadable — the pin drops on next get()
    }
    const parsed = parseFile(normalizePath(path), text);
    this.cache.set(path, parsed);
    this.watch(path);
    return parsed;
  }

  private watch(path: string): void {
    if (this.watchers.has(path)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path)),
    );
    const drop = () => this.cache.delete(path);
    watcher.onDidChange(drop);
    watcher.onDidDelete(drop);
    this.watchers.set(path, watcher);
  }

  /** Drops paths no longer pinned anywhere, so watchers don't outlive their pin. */
  retain(paths: Set<string>): void {
    for (const [path, watcher] of this.watchers) {
      if (paths.has(path)) continue;
      watcher.dispose();
      this.watchers.delete(path);
      this.cache.delete(path);
    }
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    this.cache.clear();
  }
}

export class ActiveTfvars {
  readonly external = new ExternalTfvars();

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

  valuesFor(moduleDir: string): Map<string, TfvarsValue> {
    const merged = new Map<string, TfvarsValue>();
    for (const path of this.tfvarsFor(moduleDir)) {
      // a pin outside the workspace has no indexed file, only a parsed copy
      const file = this.index.file(path) ?? this.external.get(path);
      for (const [name, value] of tfvarsValues(file)) merged.set(name, value);
    }
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
      provideHover(document, position) {
        if (!featureEnabled('resolvedHover')) {
          return undefined;
        }
        // parse the live buffer — the index is debounced and would resolve the
        // wrong token right after a keystroke. Values still resolve *through*
        // the index, so a file it doesn't contain can only produce "unknown",
        // wrongly asserting "no default" over one right there in the file
        const path = normalizePath(document.uri.fsPath);
        if (!index.file(path)) return undefined;
        const file = parseFile(path, document.getText());
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
