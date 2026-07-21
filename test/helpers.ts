import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { TfvarsValue } from '../src/core/evaluator';
import type { TextEdit } from '../src/core/hcl';
import type { Pos } from '../src/core/model';
import { initParser } from '../src/core/parser';
import type { IndexHost } from '../src/core/workspaceIndex';

/** Apply non-overlapping edits to source lines; returns the new text.
 *
 *  Test-only: the extension applies edits through vscode.WorkspaceEdit,
 *  which works on real document positions. This helper joins with '\n' and
 *  assumes a one-character terminator, so it's not a stand-in for that path
 *  on CRLF files — it exists to assert what a fix produces. */
export function applyEdits(lines: string[], edits: TextEdit[]): string {
  let text = lines.join('\n');
  const offset = (p: Pos) => lines.slice(0, p.row).reduce((n, l) => n + l.length + 1, 0) + p.column;
  const sorted = [...edits].sort((a, b) => offset(b.span.start) - offset(a.span.start));
  for (const e of sorted) {
    text = text.slice(0, offset(e.span.start)) + e.newText + text.slice(offset(e.span.end));
  }
  return text;
}

/** An EvalScope.tfvarsOf for tests: `dir` is the root module those values
 *  belong to; every other directory gets nothing, so a submodule falls back
 *  to its call site rather than a stray tfvars. */
export function tfvarsIn(
  dir: string,
  values: Record<string, string>,
  file = `${dir}/terraform.tfvars`,
): (moduleDir: string) => Map<string, TfvarsValue> {
  const map = new Map(Object.entries(values).map(([k, text]) => [k, { text, file }]));
  return (moduleDir) => (moduleDir === dir ? map : new Map());
}

const require = createRequire(import.meta.url);

export async function initTestParser(): Promise<void> {
  const runtimeWasm = join(dirname(require.resolve('web-tree-sitter')), 'web-tree-sitter.wasm');
  const grammarWasm = require
    .resolve('@tree-sitter-grammars/tree-sitter-hcl/package.json')
    .replace(/package\.json$/, 'tree-sitter-terraform.wasm');
  await initParser({ runtimeWasm, grammarWasm });
}

export function fixturePath(...parts: string[]): string {
  return join(__dirname, 'fixtures', ...parts);
}

/** IndexHost that walks a fixture directory on disk. */
export function fsHost(root: string): IndexHost {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tf') || p.endsWith('.tfvars')) files.push(p);
    }
  };
  walk(root);
  return {
    listFiles: async () => files,
    readFile: async (p: string) => readFileSync(p, 'utf8'),
  };
}
