import { basename } from 'node:path';
import * as vscode from 'vscode';
import { featureEnabled } from '../config';
import type { TfvarsValue } from '../core/evaluator';
import { parseFile } from '../core/parser';
import { normalizePath, type WorkspaceIndex } from '../core/workspaceIndex';
import { autoLoadedTfvars, computeHover, tfvarsValues } from './resolvedHover';

export const PICK_TFVARS_COMMAND = 'tfCompanion.pickTfvars';
const COPY_VALUE_COMMAND = 'tfCompanion.copyValue';
const STATE_KEY = 'tfCompanion.activeTfvars';

export class ActiveTfvars {
  constructor(
    private context: vscode.ExtensionContext,
    private index: WorkspaceIndex,
    private statusBar: vscode.StatusBarItem,
  ) {}

  /** The file the user pinned explicitly, if it is still in the workspace. */
  get(): string | undefined {
    const stored = this.context.workspaceState.get<string>(STATE_KEY);
    return stored && this.index.file(stored) ? stored : undefined;
  }

  async set(path: string): Promise<void> {
    await this.context.workspaceState.update(STATE_KEY, path);
    this.updateStatusBar();
  }

  /** Clears the pin; every root module falls back to what Terraform auto-loads. */
  async clear(): Promise<void> {
    await this.context.workspaceState.update(STATE_KEY, undefined);
    this.updateStatusBar();
  }

  updateStatusBar(): void {
    const pinned = this.get();
    // each root module reads its own tfvars, so only a deliberate pin is named
    this.statusBar.text = pinned
      ? `$(symbol-variable) tfvars: ${basename(pinned)}`
      : '$(symbol-variable) tfvars: auto';
    this.statusBar.tooltip = pinned
      ? `Terraform Companion: forcing ${pinned} for the module that contains it (click to change)`
      : 'Terraform Companion: each root module resolves values from its own terraform.tfvars / *.auto.tfvars (click to override)';
    this.statusBar.command = PICK_TFVARS_COMMAND;
    this.statusBar.show();
  }

  /** Lowest precedence first: what Terraform auto-loads, then a pin in the
   *  same dir (behaves like `-var-file`). A called module gets nothing — its
   *  values come from the call site. */
  tfvarsFor(moduleDir: string): string[] {
    // externalCallSitesOf, not callSitesOf — the evaluator ignores calls from
    // a module's own tree, so one with an examples/ folder is still a root here
    if (this.index.externalCallSitesOf(moduleDir).length > 0) return [];
    const files = autoLoadedTfvars(this.index, moduleDir);
    const pinned = this.get();
    if (!pinned || this.index.moduleDirOf(pinned) !== moduleDir) return files;
    // the pin models -var-file and outranks auto-loaded files even when it's
    // one of them, so it always merges last
    return [...files.filter((p) => p !== pinned), pinned];
  }

  valuesFor(moduleDir: string): Map<string, TfvarsValue> {
    const merged = new Map<string, TfvarsValue>();
    for (const path of this.tfvarsFor(moduleDir)) {
      for (const [name, value] of tfvarsValues(this.index.file(path))) merged.set(name, value);
    }
    return merged;
  }
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
    vscode.commands.registerCommand(COPY_VALUE_COMMAND, async (value: string) => {
      await vscode.env.clipboard.writeText(value);
    }),
    vscode.commands.registerCommand(PICK_TFVARS_COMMAND, async () => {
      const tfvars = index
        .files()
        .filter((f) => f.path.endsWith('.tfvars'))
        .map((f) => f.path)
        .sort();
      if (tfvars.length === 0) {
        // the status bar advertises this, so a silent no-op reads as a bug
        void vscode.window.showInformationMessage(
          'Terraform Companion: no .tfvars files found in this workspace.',
        );
        return;
      }
      const auto = {
        label: 'Automatic',
        description:
          "each root module uses its own terraform.tfvars / *.auto.tfvars — Terraform's own rule",
        path: undefined,
      };
      const pick = await vscode.window.showQuickPick(
        [
          auto,
          ...tfvars.map((p) => ({
            label: basename(p),
            description: p,
            path: p as string | undefined,
          })),
        ],
        { placeHolder: 'tfvars file used to resolve values' },
      );
      if (!pick) return;
      // a pin only applies to the module containing it
      if (pick.path) await active.set(pick.path);
      else await active.clear();
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
