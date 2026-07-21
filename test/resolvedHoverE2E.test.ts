import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pos } from '../src/core/model';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { computeHover, tfvarsValues } from '../src/features/resolvedHover';
import { fixturePath, fsHost, initTestParser } from './helpers';

const root = fixturePath('multimod');
let index: WorkspaceIndex;

beforeAll(async () => {
  await initTestParser();
  index = await WorkspaceIndex.build(fsHost(root));
});

/** The exact pipeline provideHover() runs, minus the VS Code wrapping. */
function simulateHover(filePath: string, pos: Pos, tfvarsPath: string): string | undefined {
  const file = index.file(filePath);
  if (!file) return undefined;
  return computeHover(file, pos, {
    index,
    tfvarsOf: (dir) =>
      dir === index.moduleDirOf(tfvarsPath) ? tfvarsValues(index.file(tfvarsPath)) : new Map(),
    copyCommand: 'tfCompanion.copyValue',
  });
}

/** Cursor position of the first reference with these parts in a file. */
function refPos(filePath: string, parts: string[]): Pos {
  const file = index.file(filePath);
  const ref = file?.refs.find((r) => parts.every((p, i) => r.parts[i] === p));
  if (!ref) throw new Error(`ref ${parts.join('.')} not found in ${filePath}`);
  return ref.span.start;
}

describe('F7 end-to-end on real files (multimod fixture)', () => {
  const netMain = join(root, 'modules/net/main.tf');
  const netVariables = join(root, 'modules/net/variables.tf');
  const rootMain = join(root, 'main.tf');
  const dev = join(root, 'dev.tfvars');
  const prod = join(root, 'prod.tfvars');

  it('hover on var.cidr inside the submodule follows the call site to the active tfvars', () => {
    const md = simulateHover(netMain, refPos(netMain, ['var', 'cidr']), dev);
    expect(md).toContain('**var.cidr** = `10.0.0.0/16`');
    expect(md).toContain('from dev.tfvars');
    expect(md).toContain('via module "net" (main.tf)');
    expect(md).toContain('[Copy value](command:tfCompanion.copyValue?');
  });

  it('switching the active tfvars from the status bar changes the resolved value', () => {
    const md = simulateHover(netMain, refPos(netMain, ['var', 'cidr']), prod);
    expect(md).toContain('**var.cidr** = `10.1.0.0/16`');
    expect(md).toContain('from prod.tfvars');
  });

  it('hover on the variable definition header in the submodule resolves the same value', () => {
    const md = simulateHover(netVariables, { row: 0, column: 12 }, dev);
    expect(md).toContain('**var.cidr** = `10.0.0.0/16`');
    expect(md).toContain('via module "net" (main.tf)');
  });

  it('hover on local.name_prefix in the root follows the var→local chain', () => {
    const devMd = simulateHover(rootMain, refPos(rootMain, ['local', 'name_prefix']), dev);
    expect(devMd).toContain('**local.name_prefix** = `dev-app`');
    expect(devMd).toContain('from dev.tfvars');
    const prodMd = simulateHover(rootMain, refPos(rootMain, ['local', 'name_prefix']), prod);
    expect(prodMd).toContain('**local.name_prefix** = `prod-app`');
  });

  it('hover on an object local renders its fields resolved', () => {
    const md = simulateHover(rootMain, refPos(rootMain, ['local', 'tags']), dev);
    expect(md).toContain('**local.tags** = `{Name = dev-app}`');
  });

  it('a root var missing from tfvars reports its default with the real file name', () => {
    const variables = join(root, 'variables.tf');
    const md = simulateHover(variables, { row: 0, column: 12 }, dev);
    // var "env" is set in dev.tfvars, so hover the definition of "lista" instead
    expect(md).toContain('**var.env** = `dev`');
    const listaFile = index.file(variables);
    const lista = listaFile?.blocks.find((b) => b.kind === 'variable' && b.labels[0] === 'lista');
    if (!lista) throw new Error('variable "lista" not found');
    const listaMd = simulateHover(variables, lista.span.start, dev);
    expect(listaMd).toContain('**var.lista** = `[a, b]`');
    expect(listaMd).toContain('default in variables.tf');
  });
});
