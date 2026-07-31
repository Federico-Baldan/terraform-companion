import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { relativeTo, tfvarsCandidates } from '../src/features/resolvedHover';
import { fixturePath, fsHost, initTestParser } from './helpers';

const ROOT = '/repo';

/** A workspace built from bare paths — content is irrelevant to discovery,
 *  which only reads paths off the index. */
async function indexOf(paths: string[]): Promise<WorkspaceIndex> {
  return WorkspaceIndex.build({
    listFiles: async () => paths,
    readFile: async () => '',
  });
}

beforeAll(async () => {
  await initTestParser();
});

describe('relativeTo', () => {
  it('writes a sibling vars folder the way you would type it', () => {
    expect(relativeTo('/repo/infra', '/repo/environments/prod.tfvars')).toBe(
      '../environments/prod.tfvars',
    );
  });

  it('keeps a file below the module free of ../', () => {
    expect(relativeTo('/repo/infra', '/repo/infra/env/prod.tfvars')).toBe('env/prod.tfvars');
  });

  it('climbs one level for a file in the parent', () => {
    expect(relativeTo('/repo/infra', '/repo/prod.tfvars')).toBe('../prod.tfvars');
  });
});

describe('tfvarsCandidates', () => {
  it('finds a central vars folder that sits above the module', async () => {
    const index = await indexOf([
      '/repo/infra/main.tf',
      '/repo/environments/dev.tfvars',
      '/repo/environments/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates.map((c) => c.label)).toEqual([
      '../environments/dev.tfvars',
      '../environments/prod.tfvars',
    ]);
    expect(candidates.every((c) => c.group === 'nearby')).toBe(true);
  });

  it('puts the module own files first, labelled by basename', async () => {
    const index = await indexOf([
      '/repo/infra/main.tf',
      '/repo/infra/terraform.tfvars',
      '/repo/environments/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates[0]).toMatchObject({ label: 'terraform.tfvars', group: 'module' });
    expect(candidates[1]?.label).toBe('../environments/prod.tfvars');
  });

  it('orders nearby by distance: own vars folder, then parent, then further up', async () => {
    const index = await indexOf([
      '/repo/team/infra/main.tf',
      '/repo/team/infra/env/local.tfvars',
      '/repo/team/shared.tfvars',
      '/repo/environments/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/team/infra', [ROOT]);
    expect(candidates.map((c) => c.label)).toEqual([
      'env/local.tfvars',
      '../shared.tfvars',
      '../../environments/prod.tfvars',
    ]);
  });

  it('ignores tfvars that answer to another module, not ones in a bare folder', async () => {
    const index = await indexOf([
      '/repo/a/main.tf',
      // another module's own file — Terraform auto-loads it there, not here
      '/repo/other/main.tf',
      '/repo/other/prod.tfvars',
      // a folder holding tfvars and no config: a vars folder, oddly named
      '/repo/shared/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/a', [ROOT]);
    expect(candidates.map((c) => c.path)).toEqual(['/repo/shared/prod.tfvars']);
  });

  it('reaches a sibling vars folder but not a sibling module dir', async () => {
    const index = await indexOf([
      '/repo/infra/main.tf',
      '/repo/vars/prod.tfvars',
      '/repo/other/main.tf',
      '/repo/other/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates.map((c) => c.path)).toEqual(['/repo/vars/prod.tfvars']);
  });

  it('stops climbing once nesting stops being a neighbourhood', async () => {
    const index = await indexOf([
      '/repo/infra/main.tf',
      '/repo/a/b/c/d/prod.tfvars', // four levels below the root: past MAX_VARS_DEPTH
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates).toEqual([]);
  });

  it('caps the list and reports that it did', async () => {
    const paths = ['/repo/infra/main.tf'];
    for (let i = 0; i < 40; i++) paths.push(`/repo/environments/env${i}.tfvars`);
    const index = await indexOf(paths);
    const { candidates, truncated } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates).toHaveLength(20);
    expect(truncated).toBe(true);
  });

  it('does not climb above the workspace root', async () => {
    const index = await indexOf(['/repo/infra/main.tf', '/outside.tfvars']);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates).toEqual([]);
  });

  /** Naming the folders (`env`/`vars`/`environments`, one level down, files
   *  directly inside) surfaced exactly one of these six and missed the rest. */
  describe('layouts a real repo actually uses', () => {
    const layouts: { name: string; mod: string; paths: string[]; expected: string[] }[] = [
      {
        name: 'a subfolder per environment',
        mod: '/repo/infra',
        paths: ['/repo/environments/prod/terraform.tfvars', '/repo/environments/dev/dev.tfvars'],
        expected: ['../environments/dev/dev.tfvars', '../environments/prod/terraform.tfvars'],
      },
      {
        name: 'a terragrunt-shaped live/<env>/<stack> tree',
        mod: '/repo/modules/vpc',
        paths: ['/repo/live/prod/vpc/terraform.tfvars', '/repo/live/dev/vpc/terraform.tfvars'],
        expected: ['../../live/dev/vpc/terraform.tfvars', '../../live/prod/vpc/terraform.tfvars'],
      },
      {
        name: 'a folder called config/',
        mod: '/repo/infra',
        paths: ['/repo/config/prod.tfvars'],
        expected: ['../config/prod.tfvars'],
      },
      {
        name: 'a folder whose name is nobody conventional: deploy/',
        mod: '/repo/infra',
        paths: ['/repo/deploy/prod.tfvars'],
        expected: ['../deploy/prod.tfvars'],
      },
      {
        name: 'a vars folder nested one deeper',
        mod: '/repo/infra',
        paths: ['/repo/envs/aws/prod.tfvars'],
        expected: ['../envs/aws/prod.tfvars'],
      },
      {
        name: 'the flat central folder that always worked',
        mod: '/repo/infra',
        paths: ['/repo/environments/prod.tfvars'],
        expected: ['../environments/prod.tfvars'],
      },
    ];

    for (const l of layouts) {
      it(l.name, async () => {
        const index = await indexOf([`${l.mod}/main.tf`, ...l.paths]);
        const { candidates } = tfvarsCandidates(index, l.mod, [ROOT]);
        expect(candidates.map((c) => c.label)).toEqual(l.expected);
      });
    }
  });

  /** Pure distance from the module put every sibling team's `env/` above the
   *  repo-wide `environments/`, because a cousin two directories away beats an
   *  aunt three away. With enough teams the file you wanted fell off the cap. */
  it('keeps the shared vars folder above other teams in a monorepo', async () => {
    const paths = [
      '/repo/teams/payments/infra/main.tf',
      '/repo/teams/payments/infra/env/prod.tfvars',
      '/repo/teams/payments/shared.tfvars',
      '/repo/environments/prod.tfvars',
    ];
    for (let i = 0; i < 6; i++) paths.push(`/repo/teams/team${i}/env/prod.tfvars`);
    const index = await indexOf(paths);
    const { candidates } = tfvarsCandidates(index, '/repo/teams/payments/infra', [ROOT]);
    expect(candidates.slice(0, 3).map((c) => c.label)).toEqual([
      'env/prod.tfvars',
      '../shared.tfvars',
      '../../../environments/prod.tfvars',
    ]);
    // the other teams still appear — the list is a shortlist, not a filter —
    // just below the folder that belongs to everyone
    expect(candidates.map((c) => c.label)).toContain('../../team0/env/prod.tfvars');
  });

  /** A `.tf` file makes a directory somebody's module, and the rule has to
   *  cover the subtree, not just the one directory: `other/env/prod.tfvars`
   *  drives `other`, exactly like `other/prod.tfvars` does. */
  it('does not reach into a vars folder inside another module', async () => {
    const index = await indexOf([
      '/repo/a/main.tf',
      '/repo/other/main.tf',
      '/repo/other/prod.tfvars',
      '/repo/other/env/prod.tfvars',
      '/repo/other/env/prod/deep.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/a', [ROOT]);
    expect(candidates).toEqual([]);
  });

  /** Descent cost more than a level of ascent, so the module's own vars folder
   *  sorted below every file in its parent — and with enough of those, fell off
   *  the end of the list entirely. */
  it('puts a vars folder inside the module above anything in its parent', async () => {
    const index = await indexOf([
      '/repo/infra/main.tf',
      '/repo/infra/deploy/prod.tfvars',
      '/repo/shared.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates.map((c) => c.label)).toEqual(['deploy/prod.tfvars', '../shared.tfvars']);
  });

  it('never lets files in an ancestor crowd out the module’s own subtree', async () => {
    const paths = ['/repo/infra/main.tf', '/repo/infra/deploy/prod.tfvars'];
    for (let i = 0; i < 25; i++) paths.push(`/repo/environments/e${i}.tfvars`);
    const index = await indexOf(paths);
    const { candidates, truncated } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates[0]?.label).toBe('deploy/prod.tfvars');
    expect(truncated).toBe(true);
  });

  /** VS Code lets a multi-root workspace nest one folder inside another, and
   *  the order they appear in is the user's. Taking the first root that matched
   *  made discovery depend on that order: list the inner folder first and the
   *  shared `environments/` stopped being reachable. The widest open root wins,
   *  because a folder the user has open is one they can be offered files from. */
  it('reaches the same files however nested workspace roots are ordered', async () => {
    const paths = ['/repo/teams/pay/infra/main.tf', '/repo/environments/prod.tfvars'];
    const mod = '/repo/teams/pay/infra';
    const outerFirst = tfvarsCandidates(await indexOf(paths), mod, [ROOT, '/repo/teams/pay']);
    const innerFirst = tfvarsCandidates(await indexOf(paths), mod, ['/repo/teams/pay', ROOT]);
    expect(outerFirst.candidates.map((c) => c.label)).toEqual([
      '../../../environments/prod.tfvars',
    ]);
    expect(innerFirst.candidates).toEqual(outerFirst.candidates);
  });

  it('treats a root with a trailing slash like one without', async () => {
    const paths = ['/repo/infra/main.tf', '/repo/environments/prod.tfvars'];
    const { candidates } = tfvarsCandidates(await indexOf(paths), '/repo/infra', ['/repo/']);
    expect(candidates.map((c) => c.label)).toEqual(['../environments/prod.tfvars']);
  });

  it('ranks a named vars folder above an accidental one at the same distance', async () => {
    const index = await indexOf([
      '/repo/infra/main.tf',
      '/repo/aaa/prod.tfvars', // alphabetically first, but says nothing
      '/repo/environments/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates.map((c) => c.label)).toEqual([
      '../environments/prod.tfvars',
      '../aaa/prod.tfvars',
    ]);
  });

  it('sees the environments layout on disk', async () => {
    const root = fixturePath('envlayout');
    const index = await WorkspaceIndex.build(fsHost(root));
    const { candidates } = tfvarsCandidates(index, `${root}/infra`, [root]);
    expect(candidates.map((c) => c.label)).toEqual([
      '../environments/dev.tfvars',
      '../environments/prod.tfvars',
    ]);
  });
});
