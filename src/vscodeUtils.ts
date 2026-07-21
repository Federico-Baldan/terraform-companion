import * as vscode from 'vscode';
import type { Span } from './core/model';
import type { IndexHost } from './core/workspaceIndex';

export const TF_GLOB = '**/*.{tf,tfvars}';
export const TF_EXCLUDE = '**/{.terraform,node_modules}/**';

export function isTfPath(path: string): boolean {
  return path.endsWith('.tf') || path.endsWith('.tfvars');
}

/** Path-based twin of TF_EXCLUDE: findFiles covers the initial scan, but
 *  watcher and open events must apply the same rule. */
export function isExcludedTfPath(path: string): boolean {
  const n = path.replace(/\\/g, '/');
  return n.includes('/.terraform/') || n.includes('/node_modules/');
}

export function toRange(span: Span): vscode.Range {
  return new vscode.Range(span.start.row, span.start.column, span.end.row, span.end.column);
}

/** IndexHost backed by the VS Code workspace API. */
export function vscodeHost(): IndexHost {
  return {
    listFiles: async () => {
      const uris = await vscode.workspace.findFiles(TF_GLOB, TF_EXCLUDE);
      return uris.map((u) => u.fsPath);
    },
    readFile: async (p) =>
      new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(p))),
  };
}
