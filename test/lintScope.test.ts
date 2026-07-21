import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { planRelint } from '../src/lintScope';
import { initTestParser } from './helpers';

beforeAll(initTestParser);

async function workspace(): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex();
  await index.updateFile('/w/main.tf', 'locals {\n  a = 1\n}\n');
  await index.updateFile('/w/other.tf', 'output "o" {\n  value = local.a\n}\n');
  await index.updateFile('/w/modules/net/main.tf', 'locals {\n  b = 2\n}\n');
  await index.updateFile('/w/modules/net/use.tf', 'output "p" {\n  value = local.b\n}\n');
  return index;
}

const paths = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe('incremental relint scope', () => {
  it('re-lints the whole module directory when a module-scoped rule is on', async () => {
    const index = await workspace();
    const plan = planRelint(index, ['/w/main.tf'], true);
    // other.tf must be included: whether local.a is unused depends on it
    expect(paths(plan.publish)).toEqual(['/w/main.tf', '/w/other.tf']);
    expect(plan.drop).toEqual([]);
  });

  it('leaves other module directories untouched', async () => {
    const index = await workspace();
    const plan = planRelint(index, ['/w/modules/net/main.tf'], true);
    expect(paths(plan.publish)).toEqual(['/w/modules/net/main.tf', '/w/modules/net/use.tf']);
  });

  it('narrows to the file alone when every enabled rule is file-scoped', async () => {
    const index = await workspace();
    const plan = planRelint(index, ['/w/main.tf'], false);
    expect(paths(plan.publish)).toEqual(['/w/main.tf']);
  });

  it('drops a deleted file and still re-lints its module', async () => {
    const index = await workspace();
    index.removeFile('/w/other.tf');
    const plan = planRelint(index, ['/w/other.tf'], true);
    // the diagnostics of a file that is gone must not linger...
    expect(plan.drop).toEqual(['/w/other.tf']);
    // ...and local.a, which only it used, now reads as unused
    expect(paths(plan.publish)).toEqual(['/w/main.tf']);
  });

  it('accepts several changed paths across directories', async () => {
    const index = await workspace();
    const plan = planRelint(index, ['/w/main.tf', '/w/modules/net/use.tf'], true);
    expect(paths(plan.publish)).toEqual([
      '/w/main.tf',
      '/w/modules/net/main.tf',
      '/w/modules/net/use.tf',
      '/w/other.tf',
    ]);
  });

  it('normalizes the paths it is handed, like every other index consumer', async () => {
    const index = await workspace();
    const plan = planRelint(index, ['\\w\\main.tf'], false);
    expect(paths(plan.publish)).toEqual(['/w/main.tf']);
  });
});
