import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { readPins, tfvarsChain } from '../src/features/resolvedHover';
import { fixturePath, fsHost, initTestParser } from './helpers';

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));

beforeAll(async () => {
  await initTestParser();
});

describe('tfvarsChain', () => {
  /** The layout that was broken: one root module driven by a vars folder that
   *  sits beside it, the way `-var-file=../environments/prod.tfvars` works. */
  describe('central environments/ folder', () => {
    let index: WorkspaceIndex;
    let root: string;

    beforeAll(async () => {
      root = fixturePath('envlayout');
      index = await WorkspaceIndex.build(fsHost(root));
    });

    it('applies a pin that lives outside the module directory', () => {
      const prod = `${root}/environments/prod.tfvars`;
      expect(tfvarsChain(index, `${root}/infra`, prod)).toEqual([prod]);
    });

    it('resolves the value through that pin', () => {
      const prod = `${root}/environments/prod.tfvars`;
      const values = new Map(
        tfvarsChain(index, `${root}/infra`, prod).flatMap((p) =>
          [...(index.file(p)?.blocks ?? [])]
            .filter((b) => b.kind === 'tfvars_entry')
            .map((b) => [b.labels[0], b.attrs[0]?.valueText] as const),
        ),
      );
      expect(values.get('env')).toBe('"prod"');
    });

    it('falls back to auto-loaded files when nothing is pinned', () => {
      // no terraform.tfvars in infra/, so Terraform would read nothing
      expect(tfvarsChain(index, `${root}/infra`, undefined)).toEqual([]);
    });
  });

  describe('module-local files', () => {
    let index: WorkspaceIndex;
    let root: string;

    beforeAll(async () => {
      root = fixturePath('multimod');
      index = await WorkspaceIndex.build(fsHost(root));
    });

    it('merges the pin last so it outranks auto-loaded files', () => {
      const prod = `${root}/prod.tfvars`;
      const chain = tfvarsChain(index, root, prod);
      expect(chain[chain.length - 1]).toBe(prod);
    });

    it('lists a pinned auto-loaded file once, at the end', () => {
      const auto = `${root}/terraform.tfvars`;
      const chain = tfvarsChain(index, root, auto);
      expect(chain.filter((p) => p === auto)).toHaveLength(1);
      expect(chain[chain.length - 1]).toBe(auto);
    });

    it('gives a called module nothing, pin or not', () => {
      const netDir = `${root}/modules/net`;
      expect(tfvarsChain(index, netDir, `${root}/prod.tfvars`)).toEqual([]);
    });
  });
});

describe('readPins migration', () => {
  it('reads the per-module map unchanged', () => {
    const stored = { '/repo/infra': '/repo/environments/prod.tfvars' };
    expect(readPins(stored, dirOf)).toEqual(stored);
  });

  it('migrates a pre-per-module string to the dir that pin used to apply to', () => {
    expect(readPins('/repo/infra/prod.tfvars', dirOf)).toEqual({
      '/repo/infra': '/repo/infra/prod.tfvars',
    });
  });

  it('treats missing or malformed state as no pins', () => {
    expect(readPins(undefined, dirOf)).toEqual({});
    expect(readPins('', dirOf)).toEqual({});
    expect(readPins(42, dirOf)).toEqual({});
    expect(readPins({ '/repo': null }, dirOf)).toEqual({});
  });
});
