import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build, context } from 'esbuild';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  // force the CJS build of web-tree-sitter: the ESM one relies on import.meta.url,
  // which does not exist in a CJS bundle (Parser.init would crash at runtime)
  alias: { 'web-tree-sitter': './node_modules/web-tree-sitter/web-tree-sitter.cjs' },
  sourcemap: true,
  logLevel: 'info',
};

// dist/ is not in .vscodeignore, so anything stale left there ships inside the
// VSIX. A wasm file renamed by a dependency bump, or a scratch copy from a
// manual test, survives every later build otherwise: rebuild it from empty.
rmSync('dist', { recursive: true, force: true });

// web-tree-sitter runtime wasm + terraform grammar wasm must sit next to the bundle
mkdirSync('dist', { recursive: true });
const wtsDir = dirname(require.resolve('web-tree-sitter'));
copyFileSync(join(wtsDir, 'web-tree-sitter.wasm'), 'dist/web-tree-sitter.wasm');
copyFileSync(
  require
    .resolve('@tree-sitter-grammars/tree-sitter-hcl/package.json')
    .replace(/package\.json$/, 'tree-sitter-terraform.wasm'),
  'dist/tree-sitter-terraform.wasm',
);

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
