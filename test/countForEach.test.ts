import { beforeAll, describe, expect, it } from 'vitest';
import type { TfvarsValue } from '../src/core/evaluator';
import { parseFile } from '../src/core/parser';
import { normalizePath, WorkspaceIndex } from '../src/core/workspaceIndex';
import { detectCountLength, rewriteToForEach } from '../src/features/countForEach';
import { tfvarsValues } from '../src/features/resolvedHover';
import { applyEdits, initTestParser } from './helpers';

beforeAll(async () => {
  await initTestParser();
});

const SRC = `resource "aws_instance" "srv" {
  count = length(var.lista)
  name  = var.lista[count.index]
  tag   = upper(var.lista[count.index])
}
`;

describe('F5 count → for_each', () => {
  it('detects count = length(list) with list[count.index] usages', () => {
    const patterns = detectCountLength(parseFile('a.tf', SRC));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.listRef).toEqual(['var', 'lista']);
    expect(patterns[0]!.indexUses).toHaveLength(2);
    expect(patterns[0]!.safeToRefactor).toBe(true);
  });

  it('rewrites to for_each = toset(...) and each.value', () => {
    const file = parseFile('a.tf', SRC);
    const [pattern] = detectCountLength(file);
    const result = applyEdits(file.lines, rewriteToForEach(pattern!));
    expect(result).toBe(`resource "aws_instance" "srv" {
  for_each = toset(var.lista)
  name  = each.value
  tag   = upper(each.value)
}
`);
  });

  it('supports the local.X variant', () => {
    const src =
      'resource "a" "b" {\n  count = length(local.items)\n  x = local.items[count.index]\n}\n';
    const patterns = detectCountLength(parseFile('b.tf', src));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.listRef).toEqual(['local', 'items']);
  });

  it('detects list names containing dashes — legal HCL identifiers', () => {
    // HCL: Identifier = ID_Start (ID_Continue | '-')* — var.my-list is valid
    // terraform the detector must not skip
    const src =
      'resource "a" "b" {\n  count = length(var.my-list)\n  x = var.my-list[count.index]\n}\n';
    const patterns = detectCountLength(parseFile('h.tf', src));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.listRef).toEqual(['var', 'my-list']);
    expect(patterns[0]!.indexUses).toHaveLength(1);
  });

  it('ignores numeric count and unrelated count.index uses', () => {
    const src = 'resource "a" "b" {\n  count = 3\n  x = var.lista[count.index]\n}\n';
    expect(detectCountLength(parseFile('c.tf', src))).toEqual([]);
  });

  it('ignores count = length() without [count.index] usage', () => {
    const src = 'resource "a" "b" {\n  count = length(var.lista)\n  x = "static"\n}\n';
    expect(detectCountLength(parseFile('d.tf', src))).toEqual([]);
  });

  it('marks unsafe when count.index also indexes a different list', () => {
    const src =
      'resource "a" "b" {\n  count = length(var.lista)\n  x = var.lista[count.index]\n  y = var.zones[count.index]\n}\n';
    const patterns = detectCountLength(parseFile('e.tf', src));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.safeToRefactor).toBe(false);
  });

  it('marks unsafe when count.index appears in an interpolation', () => {
    const src =
      'resource "a" "b" {\n  count = length(var.lista)\n  x = var.lista[count.index]\n  y = "srv-${count.index}"\n}\n';
    expect(detectCountLength(parseFile('f.tf', src))[0]!.safeToRefactor).toBe(false);
  });

  it('marks unsafe when count.index is used in index arithmetic', () => {
    const src =
      'resource "a" "b" {\n  count = length(var.lista)\n  x = var.lista[count.index]\n  y = var.lista[count.index + 1]\n}\n';
    expect(detectCountLength(parseFile('g.tf', src))[0]!.safeToRefactor).toBe(false);
  });

  it('marks unsafe when the resource is referenced elsewhere in the same file', () => {
    const src = `resource "aws_instance" "web" {
  count = length(var.names)
  name  = var.names[count.index]
}

output "first" {
  value = aws_instance.web[0].id
}
`;
    const patterns = detectCountLength(parseFile('h.tf', src));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.safeToRefactor).toBe(false);
  });

  it('marks unsafe when another file of the module references the resource', async () => {
    const files: Record<string, string> = {
      '/m/main.tf': SRC.replace('"srv"', '"web"'),
      '/m/outputs.tf': 'output "all" {\n  value = aws_instance.web[*].id\n}\n',
    };
    const index = await WorkspaceIndex.build({
      listFiles: async () => Object.keys(files),
      readFile: async (p) => files[p] ?? '',
    });
    const file = index.file('/m/main.tf')!;
    expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(false);
    // same module, but no external reference → still safe
    const alone = await WorkspaceIndex.build({
      listFiles: async () => ['/m/main.tf'],
      readFile: async () => files['/m/main.tf'] ?? '',
    });
    expect(detectCountLength(alone.file('/m/main.tf')!, alone)[0]!.safeToRefactor).toBe(true);
  });

  it('excludes the file own stale index entry only when the path is normalized', async () => {
    // what the provider passes for a live buffer on Windows — un-normalized,
    // the file's own stale copy reads as external and hides the refactor
    const winRaw = 'C:\\ws\\main.tf';
    const withOutput = `resource "aws_instance" "web" {
  count = length(var.names)
  name  = var.names[count.index]
}

output "first" {
  value = aws_instance.web[0].id
}
`;
    const outputDeleted = `resource "aws_instance" "web" {
  count = length(var.names)
  name  = var.names[count.index]
}
`;
    // index still holds the previous revision, the buffer no longer references it
    const index = await WorkspaceIndex.build({
      listFiles: async () => [winRaw],
      readFile: async () => withOutput,
    });
    expect(index.files()[0]!.path).toBe(normalizePath(winRaw));

    const normalized = detectCountLength(parseFile(normalizePath(winRaw), outputDeleted), index);
    expect(normalized[0]!.safeToRefactor).toBe(true);
  });

  it('marks unsafe for counted modules referenced outside the block', () => {
    const src = `module "web" {
  source = "./m"
  count  = length(var.names)
  name   = var.names[count.index]
}

output "out" {
  value = module.web[0].id
}
`;
    const patterns = detectCountLength(parseFile('i.tf', src));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.safeToRefactor).toBe(false);
  });
});

describe('coverage gaps that used to hide the diagnostic', () => {
  it('flags data sources, which take count and carry the same hazard', () => {
    const src = `data "aws_ami" "img" {
  count = length(var.names)
  name  = var.names[count.index]
}
`;
    const patterns = detectCountLength(parseFile(normalizePath('/w/a.tf'), src));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.safeToRefactor).toBe(true);
    expect(applyEdits(src.split('\n'), rewriteToForEach(patterns[0]!))).toBe(`data "aws_ami" "img" {
  for_each = toset(var.names)
  name  = each.value
}
`);
  });

  it('tolerates padding inside the index brackets', () => {
    // terraform fmt leaves this alone, and it used to drop the warning entirely
    const src = `resource "aws_instance" "web" {
  count = length(var.names)
  name  = var.names[ count.index ]
}
`;
    const patterns = detectCountLength(parseFile(normalizePath('/w/b.tf'), src));
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.safeToRefactor).toBe(true);
    expect(applyEdits(src.split('\n'), rewriteToForEach(patterns[0]!))).toContain(
      'name  = each.value',
    );
  });

  it('does not offer the fix when a data source is referenced elsewhere', () => {
    const src = `data "aws_ami" "img" {
  count = length(var.names)
  name  = var.names[count.index]
}
output "first" {
  value = data.aws_ami.img[0].id
}
`;
    const patterns = detectCountLength(parseFile(normalizePath('/w/c.tf'), src));
    expect(patterns[0]!.safeToRefactor).toBe(false);
  });

  /** for_each only accepts a map or set of *strings*, so toset(list) is a
   *  plan-time error when elements are objects. No working rewrite exists
   *  there, so it must not be offered. */
  describe('elements that toset() cannot turn into a for_each key', () => {
    it('marks unsafe when an element is used as an object', () => {
      const src = `resource "aws_instance" "srv" {
  count = length(var.servers)
  ami   = var.servers[count.index].ami
}
`;
      const patterns = detectCountLength(parseFile(normalizePath('/w/d.tf'), src));
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.safeToRefactor).toBe(false);
    });

    /** a.b and a["b"] read the same attribute — Terraform prefers the bracket
     *  form for non-identifier keys, so a guard that only knows dot-form hands
     *  out a rewrite that fails at plan time. The variable is untyped on
     *  purpose: `any` passes the declared-type check, and an unresolvable
     *  list tells the evaluator nothing, leaving this accessor the only signal. */
    it.each([
      ['a quoted key', 'var.servers[count.index]["ami"]'],
      ['a numeric index', 'var.servers[count.index][0]'],
      ['a space before the bracket', 'var.servers[count.index] ["ami"]'],
      ['a space before the dot', 'var.servers[count.index] .ami'],
    ])('marks unsafe when an element is read into with %s', (_name, expr) => {
      const src = `resource "aws_instance" "srv" {
  count = length(var.servers)
  ami   = ${expr}
}
`;
      const patterns = detectCountLength(parseFile(normalizePath('/w/d2.tf'), src));
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.safeToRefactor).toBe(false);
    });

    /** HCL allows the accessor on its own line, and terraform fmt keeps it
     *  there, so the scan has to look past the end of the line. */
    it('marks unsafe when the accessor sits on the next line', () => {
      const src = `resource "aws_instance" "srv" {
  count = length(var.servers)
  ami = var.servers[count.index]
    .ami
}
`;
      const patterns = detectCountLength(parseFile(normalizePath('/w/d3.tf'), src));
      expect(patterns[0]!.safeToRefactor).toBe(false);
    });

    /** The scan-ahead must not swallow the *next argument* — a plain element
     *  use ending its line is the most common shape, and losing the fix there
     *  would make the feature useless. */
    it('still offers the fix when the element is used whole', () => {
      const src = `resource "aws_instance" "srv" {
  count = length(var.names)
  name  = var.names[count.index]
  tags  = [
    "a",
  ]

  ebs_block_device {
    size = 10
  }
}
`;
      const patterns = detectCountLength(parseFile(normalizePath('/w/d4.tf'), src));
      expect(patterns[0]!.safeToRefactor).toBe(true);
    });

    it('marks unsafe when the variable declares a non-string element type', async () => {
      const index = new WorkspaceIndex();
      await index.updateFile(
        normalizePath('/w/vars.tf'),
        `variable "servers" {
  type = list(object({ ami = string }))
}
`,
      );
      const src = `resource "aws_instance" "srv" {
  count = length(var.servers)
  name  = var.servers[count.index]
}
`;
      const file = parseFile(normalizePath('/w/e.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(false);
    });

    /** toset() collapses equal values, so a repeated element yields fewer
     *  instances than count did. When the list is knowable, the refactor is
     *  simply wrong and must not be offered. */
    it('marks unsafe when the resolvable list repeats a value', async () => {
      const index = new WorkspaceIndex();
      await index.updateFile(
        normalizePath('/w/vars.tf'),
        'locals {\n  zones = ["a", "b", "a"]\n}\n',
      );
      const src = `resource "aws_subnet" "s" {
  count = length(local.zones)
  zone  = local.zones[count.index]
}
`;
      const file = parseFile(normalizePath('/w/g.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(false);
    });

    it('marks unsafe when the resolvable list holds objects', async () => {
      const index = new WorkspaceIndex();
      await index.updateFile(
        normalizePath('/w/vars.tf'),
        'locals {\n  servers = [{ ami = "x" }, { ami = "y" }]\n}\n',
      );
      const src = `resource "aws_instance" "srv" {
  count = length(local.servers)
  spec  = local.servers[count.index]
}
`;
      const file = parseFile(normalizePath('/w/h.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(false);
    });

    it('stays safe for a resolvable list of distinct strings', async () => {
      const index = new WorkspaceIndex();
      await index.updateFile(
        normalizePath('/w/vars.tf'),
        'locals {\n  zones = ["a", "b", "c"]\n}\n',
      );
      const src = `resource "aws_subnet" "s" {
  count = length(local.zones)
  zone  = local.zones[count.index]
}
`;
      const file = parseFile(normalizePath('/w/i.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(true);
    });

    it('stays safe for a declared list(string)', async () => {
      const index = new WorkspaceIndex();
      await index.updateFile(
        normalizePath('/w/vars.tf'),
        `variable "names" {
  type = list(string)
}
`,
      );
      const src = `resource "aws_instance" "srv" {
  count = length(var.names)
  name  = var.names[count.index]
}
`;
      const file = parseFile(normalizePath('/w/f.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(true);
    });
  });

  describe('non-string element types', () => {
    /** for_each accepts a map or set of *strings*. toset([8080, 8443]) is a set
     *  of numbers and fails at plan time — Terraform doesn't auto-convert.
     *  The evaluator renders every primitive as text, so these used to look
     *  like a clean string list and get offered a fix that could never apply. */
    it('refuses a local list of numbers', async () => {
      const index = new WorkspaceIndex();
      const src = `locals {
  ports = [8080, 8443]
}
resource "aws_instance" "srv" {
  count = length(local.ports)
  port  = local.ports[count.index]
}
`;
      await index.updateFile(normalizePath('/w/f.tf'), src);
      const file = parseFile(normalizePath('/w/f.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(false);
    });

    it('refuses an undeclared var defaulting to numbers', async () => {
      const index = new WorkspaceIndex();
      const src = `variable "ports" {
  default = [8080, 8443]
}
resource "aws_instance" "srv" {
  count = length(var.ports)
  port  = var.ports[count.index]
}
`;
      await index.updateFile(normalizePath('/w/f.tf'), src);
      const file = parseFile(normalizePath('/w/f.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(false);
    });

    it('refuses a list of bools', async () => {
      const index = new WorkspaceIndex();
      const src = `locals {
  flags = [true, false]
}
resource "aws_instance" "srv" {
  count   = length(local.flags)
  enabled = local.flags[count.index]
}
`;
      await index.updateFile(normalizePath('/w/f.tf'), src);
      const file = parseFile(normalizePath('/w/f.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(false);
    });

    it('still allows a resolved list of strings', async () => {
      const index = new WorkspaceIndex();
      const src = `locals {
  names = ["a", "b"]
}
resource "aws_instance" "srv" {
  count = length(local.names)
  name  = local.names[count.index]
}
`;
      await index.updateFile(normalizePath('/w/f.tf'), src);
      const file = parseFile(normalizePath('/w/f.tf'), src);
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(true);
    });
  });

  describe('values supplied by tfvars', () => {
    /** The default is what Terraform uses absent an override; tfvars exists
     *  precisely to override it. Judging the list by its default let a
     *  duplicate-free default vouch for a tfvars list full of duplicates —
     *  toset() would collapse those into fewer resources than count gave. */
    const src = `variable "names" {
  type    = list(string)
  default = ["a", "b"]
}
resource "aws_instance" "srv" {
  count = length(var.names)
  name  = var.names[count.index]
}
`;

    async function indexWith(tfvars: string): Promise<WorkspaceIndex> {
      const index = new WorkspaceIndex();
      await index.updateFile(normalizePath('/w/main.tf'), src);
      await index.updateFile(normalizePath('/w/terraform.tfvars'), tfvars);
      return index;
    }

    const ctx = (values: Map<string, TfvarsValue>) => ({
      tfvarsOf: (d: string) => (d === '/w' ? values : new Map()),
    });

    it('refuses the fix when the active tfvars holds duplicates', async () => {
      const index = await indexWith('names = ["dup", "dup"]');
      const file = parseFile(normalizePath('/w/main.tf'), src);
      const vars = tfvarsValues(index.file(normalizePath('/w/terraform.tfvars')));
      expect(detectCountLength(file, index, ctx(vars))[0]!.safeToRefactor).toBe(false);
    });

    it('allows the fix when the active tfvars holds distinct values', async () => {
      const index = await indexWith('names = ["x", "y", "z"]');
      const file = parseFile(normalizePath('/w/main.tf'), src);
      const vars = tfvarsValues(index.file(normalizePath('/w/terraform.tfvars')));
      expect(detectCountLength(file, index, ctx(vars))[0]!.safeToRefactor).toBe(true);
    });

    it('refuses the fix when the tfvars overrides a string list with numbers', async () => {
      const index = await indexWith('names = [8080, 8443]');
      const file = parseFile(normalizePath('/w/main.tf'), src);
      const vars = tfvarsValues(index.file(normalizePath('/w/terraform.tfvars')));
      expect(detectCountLength(file, index, ctx(vars))[0]!.safeToRefactor).toBe(false);
    });

    it('falls back to the default when no tfvars is active', async () => {
      const index = await indexWith('names = ["dup", "dup"]');
      const file = parseFile(normalizePath('/w/main.tf'), src);
      // no tfvars selected: the default is all there is to go on
      expect(detectCountLength(file, index)[0]!.safeToRefactor).toBe(true);
    });
  });

  /** A module with several call sites has no single list to judge. The
   *  evaluator reports that as a divergence and resolves to nothing, which
   *  used to read as "unreachable" and let the rewrite through — the same
   *  silent destruction the tfvars block above guards against, reached by a
   *  different route. One instance with duplicates is enough: toset()
   *  collapses them into fewer resources than count gave that instance,
   *  while its sibling looks perfectly fine. */
  describe('values supplied by differing module call sites', () => {
    const sub = `variable "names" {}
resource "aws_instance" "srv" {
  count = length(var.names)
  name  = var.names[count.index]
}
`;
    const callSite = (names: string) =>
      `module "app" {\n  source = "../modules/app"\n  names  = ${names}\n}\n`;

    async function indexWith(...lists: string[]): Promise<WorkspaceIndex> {
      const index = new WorkspaceIndex();
      await index.updateFile(normalizePath('/w/modules/app/main.tf'), sub);
      for (const [i, list] of lists.entries()) {
        await index.updateFile(normalizePath(`/w/env${i}/main.tf`), callSite(list));
      }
      return index;
    }

    const safeToRefactor = async (index: WorkspaceIndex) =>
      detectCountLength(parseFile(normalizePath('/w/modules/app/main.tf'), sub), index, {
        tfvarsOf: () => new Map(),
      })[0]!.safeToRefactor;

    it('refuses the fix when one instance passes duplicates', async () => {
      expect(await safeToRefactor(await indexWith('["a", "b"]', '["dup", "dup"]'))).toBe(false);
    });

    it('refuses the fix when one instance passes a list of objects', async () => {
      expect(await safeToRefactor(await indexWith('["a", "b"]', '[{ n = "x" }]'))).toBe(false);
    });

    it('refuses the fix when one instance passes numbers', async () => {
      expect(await safeToRefactor(await indexWith('["a", "b"]', '[8080, 8443]'))).toBe(false);
    });

    // the guard must not cost the fix on the case it exists to allow —
    // instances that disagree on *values* but agree every one is usable
    it('still allows the fix when every instance passes a distinct string list', async () => {
      expect(await safeToRefactor(await indexWith('["a", "b"]', '["c", "d", "e"]'))).toBe(true);
    });

    it('still allows the fix when a single instance passes a clean list', async () => {
      expect(await safeToRefactor(await indexWith('["a", "b"]'))).toBe(true);
    });
  });

  // two independent divergences on one path: c's names comes through d1
  // (instantiated twice), and c is also called directly from an unrelated
  // root. The evaluator only reports the first it meets, so stopping after
  // one pin re-evaluates into a second it never checks
  describe('divergence uncovered only after pinning a shallower one', () => {
    const c = `variable "names" {}
resource "aws_instance" "srv" {
  count = length(var.names)
  name  = var.names[count.index]
}
`;
    const d1 = `variable "seed" {}
module "c" {
  source = "../c"
  names  = var.seed
}
`;

    async function buildIndex(e1Seed: string): Promise<WorkspaceIndex> {
      const index = new WorkspaceIndex();
      await index.updateFile(normalizePath('/w/modules/c/main.tf'), c);
      await index.updateFile(normalizePath('/w/modules/d1/main.tf'), d1);
      await index.updateFile(
        normalizePath('/w/envs/e0/main.tf'),
        'module "d1" {\n  source = "../../modules/d1"\n  seed   = ["a", "b"]\n}\n',
      );
      await index.updateFile(
        normalizePath('/w/envs/e1/main.tf'),
        `module "d1" {\n  source = "../../modules/d1"\n  seed   = ${e1Seed}\n}\n`,
      );
      await index.updateFile(
        normalizePath('/w/other/main.tf'),
        'module "c" {\n  source = "../modules/c"\n  names  = ["p", "q"]\n}\n',
      );
      return index;
    }

    const safeToRefactor = async (index: WorkspaceIndex) =>
      detectCountLength(parseFile(normalizePath('/w/modules/c/main.tf'), c), index, {
        tfvarsOf: () => new Map(),
      })[0]!.safeToRefactor;

    it('refuses the fix when the second divergence, once reached, holds duplicates', async () => {
      expect(await safeToRefactor(await buildIndex('["dup", "dup"]'))).toBe(false);
    });

    it('still allows the fix when every combination reached this way is clean', async () => {
      expect(await safeToRefactor(await buildIndex('["c", "d"]'))).toBe(true);
    });
  });

  // a local forwarding a variable carries its declared type, but the check
  // used to look only at var.* heads — and the evaluator can't fill the gap,
  // since an unset variable resolves to nothing, saying nothing about its type
  describe('a local aliasing a typed variable', () => {
    const src = [
      'variable "items" { type = list(object({ n = string })) }',
      'locals { items = var.items }',
      'resource "aws_instance" "srv" {',
      '  count = length(local.items)',
      '  tags  = local.items[count.index]',
      '}',
    ].join('\n');

    const indexOf = async (files: Record<string, string>) => {
      const index = new WorkspaceIndex();
      for (const [p, s] of Object.entries(files)) await index.updateFile(normalizePath(p), s);
      return index;
    };

    it('refuses the fix through a one-hop alias', async () => {
      const index = await indexOf({ '/w/main.tf': src });
      const file = index.file(normalizePath('/w/main.tf'));
      expect(detectCountLength(file!, index)[0]!.safeToRefactor).toBe(false);
    });

    it('refuses the fix through a chain of aliases', async () => {
      const chained = src.replace(
        'locals { items = var.items }',
        'locals { raw = var.items\n  items = local.raw }',
      );
      const index = await indexOf({ '/w/main.tf': chained });
      const file = index.file(normalizePath('/w/main.tf'));
      expect(detectCountLength(file!, index)[0]!.safeToRefactor).toBe(false);
    });

    it('still allows the fix when the aliased variable is a string list', async () => {
      const ok = src.replace('list(object({ n = string }))', 'list(string)');
      const index = await indexOf({ '/w/main.tf': ok });
      const file = index.file(normalizePath('/w/main.tf'));
      expect(detectCountLength(file!, index)[0]!.safeToRefactor).toBe(true);
    });

    it('does not spin on locals that reference each other', async () => {
      const cyclic = src.replace(
        'locals { items = var.items }',
        'locals { items = local.other\n  other = local.items }',
      );
      const index = await indexOf({ '/w/main.tf': cyclic });
      const file = index.file(normalizePath('/w/main.tf'));
      expect(detectCountLength(file!, index)[0]!.safeToRefactor).toBe(true);
    });
  });
});

describe('safeToRefactor is computed only when read', () => {
  it('does not run the safety analysis for the diagnostic path', async () => {
    // pipeline re-runs this every keystroke using only countAttr.span; safety
    // analysis is for the quick fix alone. An index that explodes on scan
    // proves which path touched it
    const index = await WorkspaceIndex.build({
      listFiles: async () => ['/w/main.tf'],
      readFile: async () => SRC,
    });
    let scans = 0;
    const spy = Object.create(index) as WorkspaceIndex;
    spy.refsTo = (parts: string[]) => {
      scans++;
      return index.refsTo(parts);
    };

    const patterns = detectCountLength(parseFile('/w/main.tf', SRC), spy);
    expect(patterns).toHaveLength(1);
    expect(scans).toBe(0); // detection alone must not scan the workspace

    expect(patterns[0]!.safeToRefactor).toBe(true);
    const afterFirstRead = scans;
    expect(afterFirstRead).toBeGreaterThan(0);

    // and memoised: the provider reading it twice pays once
    expect(patterns[0]!.safeToRefactor).toBe(true);
    expect(scans).toBe(afterFirstRead);
  });
});
