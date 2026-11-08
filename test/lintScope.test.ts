import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { buildLintRules } from '../src/lintRules';
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

/** The plan used to be computed by copying every indexed file and filtering by
 *  directory — O(workspace) on every debounced keystroke, 2.8ms at 10000 files
 *  for an edit that reaches five. It now asks the index for the directory's own
 *  files. The reference below is the old computation, kept here verbatim, so the
 *  two can be compared over every shape of change rather than the handful above. */
describe('relint plan, against the whole-index filter it replaced', () => {
  function reference(index: WorkspaceIndex, changed: readonly string[], moduleScoped: boolean) {
    const set = new Set(changed.map((p) => p.replace(/\\/g, '/')));
    const dirs = moduleScoped ? new Set([...set].map((p) => index.moduleDirOf(p))) : undefined;
    return index
      .files()
      .filter((f) => (dirs ? dirs.has(index.moduleDirOf(f.path)) : set.has(f.path)))
      .map((f) => f.path);
  }

  async function mixed(): Promise<WorkspaceIndex> {
    const index = await workspace();
    await index.updateFile('/w/terraform.tfvars', 'a = 1\n');
    await index.updateFile('/w/modules/net/prod.tfvars', 'b = 2\n');
    await index.updateFile('/w/envs/dev/main.tf', 'locals {\n  e = 1\n}\n');
    await index.updateFile('/w/envs/dev/dev.auto.tfvars', 'e = 2\n');
    return index;
  }

  const universe = [
    '/w/main.tf',
    '/w/other.tf',
    '/w/terraform.tfvars',
    '/w/modules/net/main.tf',
    '/w/modules/net/use.tf',
    '/w/modules/net/prod.tfvars',
    '/w/envs/dev/main.tf',
    '/w/envs/dev/dev.auto.tfvars',
    '/w/gone.tf', // never indexed, as a deleted file's path is
  ];

  it('publishes the same .tf files for every combination of changed paths', async () => {
    const index = await mixed();
    for (let mask = 1; mask < 1 << universe.length; mask++) {
      const changed = universe.filter((_, i) => mask & (1 << i));
      const plan = planRelint(index, changed, true);
      // a tfvars has no rule that applies to it, so republishing one only ever
      // wrote an empty entry over an empty entry — the .tf files are the plan
      const expected = reference(index, changed, true).filter((p) => p.endsWith('.tf'));
      expect(paths(plan.publish)).toEqual(expected.sort());
      expect(plan.drop.sort()).toEqual(changed.filter((p) => !index.file(p)).sort());
    }
  });

  it('publishes exactly the changed files when no rule reaches past the file', async () => {
    const index = await mixed();
    for (let mask = 1; mask < 1 << universe.length; mask++) {
      const changed = universe.filter((_, i) => mask & (1 << i));
      const plan = planRelint(index, changed, false);
      expect(paths(plan.publish)).toEqual(reference(index, changed, false).sort());
    }
  });

  /** `planRelint` republishes a directory's .tf files and nothing else. That is
   *  exact only while no rule applies to a tfvars: one that did would have to be
   *  re-run for them, and would go stale here with no other test failing. */
  it('relies on no lint rule applying to a tfvars file', () => {
    for (const rule of buildLintRules()) {
      expect(rule.appliesTo('/w/prod.tfvars'), rule.feature).toBe(false);
      expect(rule.appliesTo('/w/prod.auto.tfvars'), rule.feature).toBe(false);
    }
  });
});
