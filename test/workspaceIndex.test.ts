import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePath, resolveRel, WorkspaceIndex } from '../src/core/workspaceIndex';
import { fixturePath, fsHost, initTestParser } from './helpers';

const root = fixturePath('multimod').replace(/\\/g, '/');
let index: WorkspaceIndex;

beforeAll(async () => {
  await initTestParser();
  index = await WorkspaceIndex.build(fsHost(root));
});

describe('path normalization', () => {
  it('matches what the index keys paths by, so live-buffer parses compare equal', async () => {
    const idx = new WorkspaceIndex();
    await idx.updateFile('C:\\w\\main.tf', 'resource "aws_instance" "web" {}');
    // a live buffer arrives as a raw fsPath, and the lint rules compare by equality
    expect(normalizePath('C:\\w\\main.tf')).toBe('C:/w/main.tf');
    expect(idx.files()[0]!.path).toBe(normalizePath('C:\\w\\main.tf'));
    expect(idx.file(normalizePath('C:\\w\\main.tf'))).toBeDefined();
  });
});

describe('resolveRel', () => {
  it('spells a directory the same way dirOf does, including from a "." base', async () => {
    // dirOf() gives "." at the top of the tree, so "./modules/vpc" would
    // match no indexed directory, making the call site invisible
    expect(resolveRel('.', './modules/vpc')).toBe('modules/vpc');
    expect(resolveRel('./envs/dev', '../../modules/vpc')).toBe('modules/vpc');
    // and the ordinary absolute/relative shapes are untouched
    expect(resolveRel('/w', './modules/vpc')).toBe('/w/modules/vpc');
    expect(resolveRel('/w/envs/dev', '../../modules/vpc')).toBe('/w/modules/vpc');
    expect(resolveRel('a/b', '../c')).toBe('a/c');
  });

  it('spells the top of the tree the way dirOf does when climbing out of it', () => {
    // the mirror of the case above: an emptied segment list joins to "", which
    // dirOf() spells "."
    expect(resolveRel('modules/vpc', '../..')).toBe('.');
    expect(resolveRel('envs/dev', '../..')).toBe('.');
    // an absolute base keeps its root: "/w/.." is "/"
    expect(resolveRel('/w', '..')).toBe('');
    expect(resolveRel('/w/envs', '../..')).toBe('');
    // and a normal upward hop is unchanged
    expect(resolveRel('modules/vpc', '..')).toBe('modules');
  });

  it('clamps at the filesystem root instead of turning absolute into relative', () => {
    // popping past the root used to erase that the base was absolute,
    // resolving "/a" + "../../b" to the relative key "b"
    expect(resolveRel('/a', '../../b')).toBe('/b');
    expect(resolveRel('/a', '../../../b')).toBe('/b');
    expect(resolveRel('/a/b', '../../../c')).toBe('/c');
  });

  it('resolves a call site from a root module sitting at the top of the tree', async () => {
    const idx = new WorkspaceIndex();
    await idx.updateFile('main.tf', 'module "v" {\n  source = "./modules/vpc"\n  name = "x"\n}\n');
    await idx.updateFile('modules/vpc/main.tf', 'variable "name" {}\n');
    expect(idx.moduleDirOf('main.tf')).toBe('.');
    expect(idx.callSitesOf('modules/vpc')).toHaveLength(1);
    expect(idx.externalCallSitesOf('modules/vpc')).toHaveLength(1);
  });
});

describe('workspace index', () => {
  it('indexes all fixture files', () => {
    expect(index.files().length).toBe(8);
  });

  it('finds references by prefix', () => {
    const refs = index.refsTo(['local', 'name_prefix']);
    const files = refs.map((r) => r.file);
    expect(files.some((f) => f.endsWith('main.tf'))).toBe(true);
    expect(files.some((f) => f.endsWith('locals.tf'))).toBe(true);
  });

  it('resolves local module topology recursively', () => {
    expect(index.modulesOf(root)).toEqual([`${root}/modules/net`]);
  });

  it('computes addresses for blocks', () => {
    const resources = index.blocksByKind('resource');
    const addrs = resources.map((r) => index.address(r.block));
    expect(addrs).toContain('aws_instance.web');
    expect(addrs).toContain('aws_subnet.a');
    const modules = index.blocksByKind('module');
    expect(modules.map((m) => index.address(m.block))).toContain('module.net');
  });

  it('lists variables and locals per module dir', () => {
    expect([...index.variablesOf(root).keys()].sort()).toEqual(['cidr', 'env', 'lista']);
    expect([...index.variablesOf(`${root}/modules/net`).keys()]).toEqual(['cidr']);
    const locals = index.localsOf(root).map((l) => l.name);
    expect(locals).toEqual(['name_prefix', 'tags', 'unused_thing']);
  });

  it('re-parses a single file on update', async () => {
    const before = index.refsTo(['var', 'brand_new']).length;
    expect(before).toBe(0);
    await index.updateFile(`${root}/extra.tf`, 'locals { x = var.brand_new }');
    expect(index.refsTo(['var', 'brand_new']).length).toBe(1);
    index.removeFile(`${root}/extra.tf`);
    expect(index.refsTo(['var', 'brand_new']).length).toBe(0);
  });
});

describe('pathsUnder', () => {
  it('lists every indexed file a folder deletion takes with it, recursively', async () => {
    // VS Code reports a deleted folder as one event and nothing for the files
    // inside, so anything missed here survives as a ghost in the index
    const idx = new WorkspaceIndex();
    await idx.updateFile('/w/main.tf', 'variable "x" {}\n');
    await idx.updateFile('/w/modules/net/main.tf', 'variable "cidr" {}\n');
    await idx.updateFile('/w/modules/net/deep/sub.tf', 'variable "y" {}\n');
    await idx.updateFile('/w/modules/network/main.tf', 'variable "z" {}\n');
    expect(idx.pathsUnder('/w/modules/net').sort()).toEqual([
      '/w/modules/net/deep/sub.tf',
      '/w/modules/net/main.tf',
    ]);
    // prefix means path segments: modules/network is not under modules/net
    expect(idx.pathsUnder('/w/modules/network')).toEqual(['/w/modules/network/main.tf']);
    // the folder path arrives as a raw fsPath, backslashes included
    expect(idx.pathsUnder('\\w\\modules\\net').sort()).toEqual([
      '/w/modules/net/deep/sub.tf',
      '/w/modules/net/main.tf',
    ]);
    expect(idx.pathsUnder('/w/nothing/here')).toEqual([]);
  });
});

describe('externalCallSitesOf', () => {
  it("ignores call sites inside the module's own tree, keeps real ones", async () => {
    // the evaluator and the tfvars selection both branch on root-vs-called and
    // have to agree, or the module reads no tfvars at all
    const index = await WorkspaceIndex.build({
      listFiles: async () => ['/m/main.tf', '/m/examples/basic/main.tf', '/app/main.tf'],
      readFile: async (p) => {
        if (p === '/m/examples/basic/main.tf') return 'module "self" {\n  source = "../.."\n}\n';
        if (p === '/app/main.tf') return 'module "m" {\n  source = "../m"\n}\n';
        return 'variable "x" {}\n';
      },
    });
    expect(index.callSitesOf('/m')).toHaveLength(2);
    const external = index.externalCallSitesOf('/m');
    expect(external).toHaveLength(1);
    expect(external[0]!.callerDir).toBe('/app');
    // with only the examples call, the module counts as a root
    index.removeFile('/app/main.tf');
    expect(index.externalCallSitesOf('/m')).toHaveLength(0);
  });
});

describe('refsTo does not hand out index-owned state', () => {
  it('survives a caller mutating the array it returned', async () => {
    // the two-part fast path used to serve the prebuilt bucket by reference
    const index = await WorkspaceIndex.build({
      listFiles: async () => ['/w/main.tf'],
      readFile: async () => 'locals {\n  a = 1\n}\noutput "o" {\n  value = local.a\n}\n',
    });
    const first = index.refsTo(['local', 'a']);
    expect(first).toHaveLength(1);
    first.pop();
    expect(index.refsTo(['local', 'a'])).toHaveLength(1);
  });
});

describe('build resilience', () => {
  it('skips a file that vanished between the listing and the read', async () => {
    // readFile rejects with FileNotFound when a file vanishes between
    // findFiles() and the read. build() is awaited in activate() before any
    // provider registers, so a reject took every feature down
    const skipped: string[] = [];
    const index = await WorkspaceIndex.build(
      {
        listFiles: async () => ['/w/a.tf', '/w/gone.tf', '/w/b.tf'],
        readFile: async (p: string) => {
          if (p === '/w/gone.tf') throw new Error('EntryNotFound');
          return 'locals {\n  x = 1\n}\n';
        },
      },
      (path) => skipped.push(path),
    );
    expect(index.files().map((f) => f.path)).toEqual(['/w/a.tf', '/w/b.tf']);
    expect(skipped).toEqual(['/w/gone.tf']);
  });
});
