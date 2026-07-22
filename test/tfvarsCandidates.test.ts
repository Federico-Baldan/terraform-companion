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

  it('ignores tfvars belonging to unrelated modules', async () => {
    const index = await indexOf([
      '/repo/a/main.tf',
      '/repo/b/prod.tfvars',
      '/repo/c/deep/nested/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/a', [ROOT]);
    expect(candidates).toEqual([]);
  });

  it('reaches a sibling vars folder but not a sibling module dir', async () => {
    const index = await indexOf([
      '/repo/infra/main.tf',
      '/repo/vars/prod.tfvars',
      '/repo/other/prod.tfvars',
    ]);
    const { candidates } = tfvarsCandidates(index, '/repo/infra', [ROOT]);
    expect(candidates.map((c) => c.path)).toEqual(['/repo/vars/prod.tfvars']);
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
