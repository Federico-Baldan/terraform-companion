import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..');
const runtimeWasm = join(repoRoot, 'dist', 'web-tree-sitter.wasm');
const grammarWasm = join(repoRoot, 'dist', 'tree-sitter-terraform.wasm');

const require = createRequire(import.meta.url);

/** The rest of the suite resolves both wasm files out of node_modules, but the
 *  packaged extension loads them from dist/ (src/extension.ts) after
 *  esbuild.mjs copies them there. A bump that renames or relocates either file
 *  leaves every other test green and breaks activation instead, so this file
 *  builds first and then exercises the layout the VSIX actually ships. */
beforeAll(() => {
  execFileSync('node', ['esbuild.mjs'], { cwd: repoRoot, stdio: 'ignore' });
}, 60_000);

describe('packaged bundle', () => {
  it('copies both wasm files into dist', () => {
    for (const wasm of [runtimeWasm, grammarWasm]) {
      expect(existsSync(wasm), `${wasm} missing`).toBe(true);
      expect(statSync(wasm).size).toBeGreaterThan(1024);
    }
  });

  it('parses HCL through the CJS runtime the bundle aliases', async () => {
    // esbuild.mjs forces web-tree-sitter.cjs: the ESM build relies on
    // import.meta.url, which does not exist in a CJS bundle. Loading the same
    // file keeps that alias covered rather than the ESM entry point.
    const { Language, Parser } = require(
      join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.cjs'),
    );
    await Parser.init({ locateFile: () => runtimeWasm });
    const language = await Language.load(grammarWasm);
    const parser = new Parser();
    parser.setLanguage(language);

    const tree = parser.parse('resource "aws_s3_bucket" "b" {\n  count = length(var.names)\n}\n');
    expect(tree.rootNode.type).toBe('config_file');
    expect(tree.rootNode.hasError).toBe(false);
  });
});
