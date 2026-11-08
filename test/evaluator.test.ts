import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type EvalScope,
  emptyUsage,
  listShape,
  resolveContext,
  resolveExpr,
  resolveRef,
  UNKNOWN,
} from '../src/core/evaluator';
import * as parser from '../src/core/parser';
import { parseFile } from '../src/core/parser';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { initTestParser, tfvarsIn } from './helpers';

let scope: EvalScope;

beforeAll(async () => {
  await initTestParser();
  const index = new WorkspaceIndex();
  await index.updateFile(
    '/mod/variables.tf',
    [
      'variable "env" {',
      '  default = "dev"',
      '}',
      'variable "region" {',
      '  type = string',
      '}',
      'variable "settings" {',
      '  default = { tier = "gold" }',
      '}',
      '',
    ].join('\n'),
  );
  await index.updateFile(
    '/mod/locals.tf',
    [
      'locals {',
      '  name_prefix = "${var.env}-app"',
      '  double      = "${local.name_prefix}-x"',
      '  looper      = local.looper',
      '  cfg = {',
      '    name      = "app-${var.env}"',
      '    port      = 8080',
      '    "odd-key" = "yes"',
      '    db        = { host = "db.${var.env}.internal" }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  scope = { index, moduleDir: '/mod', tfvarsOf: tfvarsIn('/mod', { override: '"from-tfvars"' }) };
});

describe('F7 evaluator', () => {
  it('resolves literals', () => {
    expect(resolveExpr('"hello"', scope)).toBe('hello');
    expect(resolveExpr('42', scope)).toBe('42');
    expect(resolveExpr('true', scope)).toBe('true');
  });

  it('resolves var from tfvars values first, then declaration defaults', () => {
    expect(resolveRef(['var', 'override'], scope)).toBe('from-tfvars');
    expect(resolveRef(['var', 'env'], scope)).toBe('dev');
    expect(resolveRef(['var', 'region'], scope)).toBe(UNKNOWN);
  });

  it('follows the var→local chain through interpolations', () => {
    expect(resolveRef(['local', 'name_prefix'], scope)).toBe('dev-app');
    expect(resolveRef(['local', 'double'], scope)).toBe('dev-app-x');
  });

  it('evaluates supported functions', () => {
    expect(resolveExpr('join("-", ["a", var.env])', scope)).toBe('a-dev');
    expect(resolveExpr('upper(var.env)', scope)).toBe('DEV');
    expect(resolveExpr('lower("ABC")', scope)).toBe('abc');
    expect(resolveExpr('format("%s-%s", var.env, "x")', scope)).toBe('dev-x');
    expect(resolveExpr('concat(["a"], ["b"])', scope)).toBe('[a, b]');
  });

  it('toset collapses duplicates and sorts, as terraform sets do', () => {
    // rendering `[a, a]` for a set is a value terraform can never produce
    expect(resolveExpr('toset(["b", "a", "b"])', scope)).toBe('[a, b]');
    // non-strings keep their elements: the shape checks still need them
    expect(resolveExpr('toset([8080, 8080])', scope)).toBe('[8080, 8080]');
  });

  /** A set converts to a list wherever a function wants one, so wrapping a list
   *  in `toset` must not turn a resolvable `join` into ⟨unknown⟩. */
  it('joins and re-sets a set, which converts to a list for the call', () => {
    expect(resolveExpr('join(",", toset(["b", "a", "b"]))', scope)).toBe('a,b');
    expect(resolveExpr('toset(toset(["b", "a"]))', scope)).toBe('[a, b]');
  });

  /** Terraform reports a module's directory as it was loaded, relative to the
   *  root module's directory, and only `path.cwd` as an absolute path (see
   *  GetPathAttr in hashicorp/terraform internal/terraform/evaluate.go). */
  it('reports path.module and path.root relative to the root module, like terraform', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile(
      '/work/infra/main.tf',
      'module "vpc" {\n  source = "./modules/vpc"\n}\nmodule "shared" {\n  source = "../shared/vpc"\n}\n',
    );
    await index.updateFile('/work/infra/modules/vpc/main.tf', 'locals {}\n');
    await index.updateFile('/work/shared/vpc/main.tf', 'locals {}\n');
    const at = (moduleDir: string): EvalScope => ({ index, moduleDir, rootDir: '/work/infra' });
    expect(resolveRef(['path', 'root'], at('/work/infra'))).toBe('.');
    expect(resolveRef(['path', 'module'], at('/work/infra'))).toBe('.');
    expect(resolveRef(['path', 'module'], at('/work/infra/modules/vpc'))).toBe('modules/vpc');
    expect(resolveRef(['path', 'module'], at('/work/shared/vpc'))).toBe('../shared/vpc');
  });

  it('keeps a configured path.cwd as given, absolute', () => {
    expect(resolveRef(['path', 'cwd'], { ...scope, cwd: '/terraform-run' })).toBe('/terraform-run');
  });

  it('format supports %q (quoted) and %% (literal percent)', () => {
    expect(resolveExpr('format("env is %q", var.env)', scope)).toBe('env is "dev"');
    expect(resolveExpr('format("100%% %s", var.env)', scope)).toBe('100% dev');
  });

  it('marks unsupported constructs as unknown, embedded in templates', () => {
    expect(resolveExpr('somefunc(1)', scope)).toBe(UNKNOWN);
    expect(resolveExpr('"${uuid()}-app"', scope)).toBe(`${UNKNOWN}-app`);
  });

  it('caps recursion on self-referencing locals', () => {
    expect(resolveRef(['local', 'looper'], scope)).toBe(UNKNOWN);
  });

  it('decodes quoted-string escape sequences to the value terraform produces', () => {
    expect(resolveExpr(String.raw`"a\nb"`, scope)).toBe('a\nb');
    expect(resolveExpr(String.raw`"quote \" backslash \\"`, scope)).toBe('quote " backslash \\');
    expect(resolveExpr(String.raw`"tab\there"`, scope)).toBe('tab\there');
    expect(resolveExpr(String.raw`"uni A astral \U0001F600"`, scope)).toBe('uni A astral 😀');
    expect(resolveExpr('"dollar $${literal} percent %%{x"', scope)).toBe(
      'dollar ${literal} percent %{x',
    );
    expect(resolveExpr('"uni \\u0041"', scope)).toBe('uni A');
  });

  /** A directive used to be skipped as an unrecognised child, joining the
   *  surviving literals — so "data-%{ if … }live%{ else }test%{ endif }" came
   *  back as "data-": wrong, but plausible enough to offer a copy. */
  describe('template directives', () => {
    it('never invents a value for a conditional directive', () => {
      expect(resolveExpr('"data-%{ if true }live%{ else }test%{ endif }"', scope)).toBe(UNKNOWN);
      expect(resolveExpr('"app-%{ if var.env == "prod" }p%{ else }d%{ endif }-x"', scope)).toBe(
        UNKNOWN,
      );
    });

    it('never invents a value for a for directive', () => {
      expect(resolveExpr('"%{ for x in ["a","b"] }${x},%{ endfor }"', scope)).toBe(UNKNOWN);
    });

    it('gives up on the whitespace-stripping form too', () => {
      expect(resolveExpr('"a%{~ if true ~}b%{~ endif ~}c"', scope)).toBe(UNKNOWN);
    });

    it('still resolves a local whose value is a directive-free template', () => {
      // guards against the fix over-reaching — plain literals, interpolations,
      // and the escaped %%{ form must keep resolving
      expect(resolveExpr('"${var.env}-app"', scope)).toBe('dev-app');
      expect(resolveExpr('"literal %%{ if } text"', scope)).toBe('literal %{ if } text');
      expect(resolveExpr('""', scope)).toBe('');
    });
  });

  it('renders numeric literals as cty prints them, not as they were spelled', () => {
    expect(resolveExpr('"p${1.50}"', scope)).toBe('p1.5');
    expect(resolveExpr('"p${007}"', scope)).toBe('p7');
    // scientific notation needs numeric evaluation we don't do: never echo "1e3"
    expect(resolveExpr('"p${1e3}"', scope)).toBe(`p${UNKNOWN}`);
  });

  /** go-cty renders %v numbers with big.Float's %g, so format("%v", 1000000)
   *  is "1e+06" — echoing the canonical decimal text would be wrong. */
  it('gives up on %v numbers that go-cty would print in scientific notation', () => {
    expect(resolveExpr('format("%v", 1000000)', scope)).toBe(UNKNOWN);
    expect(resolveExpr('format("%v", 0.00001)', scope)).toBe(UNKNOWN);
    // inside the window %g and the canonical text agree byte for byte
    expect(resolveExpr('format("%v", 8080)', scope)).toBe('8080');
    expect(resolveExpr('format("%v", 999999)', scope)).toBe('999999');
    expect(resolveExpr('format("%v", 0.0001)', scope)).toBe('0.0001');
    expect(resolveExpr('format("is %v", true)', scope)).toBe('is true');
    expect(resolveExpr('format("%v-x", var.env)', scope)).toBe('dev-x');
    // %s and %d never go scientific in go-cty, so the text stays exact there
    expect(resolveExpr('format("%s", 1000000)', scope)).toBe('1000000');
    expect(resolveExpr('format("%d", 1000000)', scope)).toBe('1000000');
  });

  /** An attribute path longer than `head.name` used to return undefined, so
   *  local.cfg.port reported the whole object as unknown. */
  describe('objects and attribute paths', () => {
    it('renders an object literal', () => {
      expect(resolveExpr('{ name = "app", port = 8080 }', scope)).toBe('{name = app, port = 8080}');
    });

    it('reads a field out of a local object', () => {
      expect(resolveRef(['local', 'cfg', 'name'], scope)).toBe('app-dev');
      expect(resolveRef(['local', 'cfg', 'port'], scope)).toBe('8080');
    });

    it('walks nested objects', () => {
      expect(resolveRef(['local', 'cfg', 'db', 'host'], scope)).toBe('db.dev.internal');
    });

    it('reads a quoted key', () => {
      expect(resolveRef(['local', 'cfg', 'odd-key'], scope)).toBe('yes');
    });

    it('is unknown for a field that does not exist, or a path into a string', () => {
      expect(resolveRef(['local', 'cfg', 'nope'], scope)).toBe(UNKNOWN);
      expect(resolveRef(['var', 'env', 'nope'], scope)).toBe(UNKNOWN);
    });

    it('reads a field out of a variable default', () => {
      expect(resolveRef(['var', 'settings', 'tier'], scope)).toBe('gold');
    });
  });
});

describe('whitespace touching a template literal is content, not separator', () => {
  // whitespace is a grammar "extra" and belongs to no named node, so
  // concatenating children's text used to delete every space at a literal's edge
  it('keeps the spaces around an interpolation', () => {
    expect(resolveExpr('"hello ${var.env} world"', scope)).toBe('hello dev world');
    expect(resolveExpr('"${var.env} lead"', scope)).toBe('dev lead');
    expect(resolveExpr('"trail ${var.env}"', scope)).toBe('trail dev');
  });

  it('keeps leading and trailing padding in a plain string', () => {
    expect(resolveExpr('"  spaced  "', scope)).toBe('  spaced  ');
    expect(resolveExpr('"   "', scope)).toBe('   ');
  });

  it('still decodes escapes across the seam', () => {
    expect(resolveExpr('"a\\tb ${var.env} c"', scope)).toBe('a\tb dev c');
  });

  it('leaves interior whitespace alone, as it always did', () => {
    expect(resolveExpr('"a  b"', scope)).toBe('a  b');
  });
});

describe('scientific notation resolves to unknown, never to its mantissa', () => {
  it('does not report 1e3 as 1', () => {
    expect(resolveExpr('1e3', scope)).toBe(UNKNOWN);
    expect(resolveExpr('1e10', scope)).toBe(UNKNOWN);
  });
});

/** A reference reached N ways was evaluated N times, each hop re-parsing the
 *  local's text, so the cost of one hover was fan-out to the power of the chain
 *  length. Twelve lines of HCL took over a minute of frozen extension host and
 *  produced tens of megabytes of ⟨unknown⟩ that the renderer discards. */
describe('a reference that fans out', () => {
  it('resolves in linear time and returns a bounded value', async () => {
    const index = new WorkspaceIndex();
    const fanout = 4;
    const levels = 12;
    const lines = ['locals {'];
    for (let i = 0; i < levels; i++) {
      lines.push(`  l${i} = "${`\${local.l${i + 1}}`.repeat(fanout)}"`);
    }
    lines.push(`  l${levels} = "leaf"`, '}', '');
    await index.updateFile('/fan/locals.tf', lines.join('\n'));
    const fanScope: EvalScope = { index, moduleDir: '/fan' };

    const started = Date.now();
    const value = resolveRef(['local', 'l0'], fanScope);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    // capped rather than 4^12 copies of "leaf"
    expect(value.length).toBeLessThan(600_000);
  });

  it('still resolves a chain longer than the old depth cap', () => {
    // cycles are cut by the in-progress guard now, so an honest chain is no
    // longer truncated at ten hops
    expect(resolveRef(['local', 'double'], scope)).toBe('dev-app-x');
  });
});

/** The cap above only ever guarded the string-interpolation path. The memo
 *  hands the same array or Map back on every cache hit, so `[local.b, local.b]`
 *  holds one array twice — a DAG — and a renderer expanding it as a tree
 *  doubled its work per level. Measured before the budget: 41,943,036
 *  characters in 1.6s of blocked extension host, from these 25 lines. */
describe('a value that shares structure', () => {
  it('renders a list DAG within the cap instead of expanding it', async () => {
    const index = new WorkspaceIndex();
    const levels = 22;
    const lines = ['locals {', '  a0 = ["leaf"]'];
    for (let i = 1; i <= levels; i++) lines.push(`  a${i} = [local.a${i - 1}, local.a${i - 1}]`);
    lines.push('}', '');
    await index.updateFile('/dag/locals.tf', lines.join('\n'));

    const started = Date.now();
    const value = resolveRef(['local', `a${levels}`], { index, moduleDir: '/dag' });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(value?.length ?? 0).toBeLessThan(200_000);
    // truncated, and saying so — a clipped value must not read as a whole one
    expect(value?.endsWith('…')).toBe(true);
  });

  it('renders an object DAG within the cap as well', async () => {
    const index = new WorkspaceIndex();
    const lines = ['locals {', '  m0 = { leaf = "x" }'];
    for (let i = 1; i <= 20; i++) {
      lines.push(`  m${i} = { a = local.m${i - 1}, b = local.m${i - 1} }`);
    }
    lines.push('}', '');
    await index.updateFile('/dag/objects.tf', lines.join('\n'));

    const started = Date.now();
    const value = resolveRef(['local', 'm20'], { index, moduleDir: '/dag' });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(value?.length ?? 0).toBeLessThan(200_000);
  });

  it('leaves a small shared value rendered in full', () => {
    // the budget must not truncate anything a reader would actually be shown
    expect(resolveRef(['local', 'double'], scope)).toBe('dev-app-x');
  });
});

/** The DAG budget above rests on the memo handing back the *same* array, so a
 *  value that is shared is not a value that is copied. `concat` breaks that: it
 *  allocates a new array as long as the sum of its inputs, and `format`/`join`
 *  do the same for strings. Each was unbounded, and each was built in full
 *  before the renderer's char budget could look at it. */
describe('values that are copied, not shared', () => {
  it('bounds a concat that doubles its own input', async () => {
    const index = new WorkspaceIndex();
    const levels = 24;
    const lines = ['locals {', '  a0 = ["leaf"]'];
    for (let i = 1; i <= levels; i++) {
      lines.push(`  a${i} = concat(local.a${i - 1}, local.a${i - 1})`);
    }
    lines.push('}', '');
    await index.updateFile('/copy/locals.tf', lines.join('\n'));

    // measured unbounded at these levels: ~2s and 560MB, rising to 7.4s and
    // 2.6GB two levels up and a RangeError two levels above that
    const started = Date.now();
    const value = resolveRef(['local', `a${levels}`], { index, moduleDir: '/copy' });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(value?.length ?? 0).toBeLessThan(200_000);
  });

  it('bounds a format that doubles its own input', async () => {
    const index = new WorkspaceIndex();
    const levels = 22;
    const lines = ['locals {', '  f0 = "0123456789"'];
    for (let i = 1; i <= levels; i++) {
      lines.push(`  f${i} = format("%s%s", local.f${i - 1}, local.f${i - 1})`);
    }
    lines.push('}', '');
    await index.updateFile('/copy/fmt.tf', lines.join('\n'));

    const started = Date.now();
    const value = resolveRef(['local', `f${levels}`], { index, moduleDir: '/copy' });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(value?.length ?? 0).toBeLessThan(200_000);
  });

  it('bounds a join over a doubled list', async () => {
    const index = new WorkspaceIndex();
    const lines = ['locals {', '  b0 = ["0123456789"]'];
    for (let i = 1; i <= 20; i++) lines.push(`  b${i} = concat(local.b${i - 1}, local.b${i - 1})`);
    lines.push('  s = join("", local.b20)', '}', '');
    await index.updateFile('/copy/join.tf', lines.join('\n'));

    const value = resolveRef(['local', 's'], { index, moduleDir: '/copy' });
    // the budget used to detect the overrun and emit the 10MB anyway
    expect(value?.length ?? 0).toBeLessThan(200_000);
  });

  it('still resolves ordinary concat, format and join in full', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile(
      '/ok/locals.tf',
      [
        'locals {',
        '  parts = concat(["a"], ["b", "c"])',
        '  label = format("%s-%s", "app", "prod")',
        '  csv   = join(",", ["x", "y"])',
        '  padded = format("%08d", 42)',
        '}',
        '',
      ].join('\n'),
    );
    const at = { index, moduleDir: '/ok' };
    expect(resolveRef(['local', 'parts'], at)).toBe('[a, b, c]');
    expect(resolveRef(['local', 'label'], at)).toBe('app-prod');
    expect(resolveRef(['local', 'csv'], at)).toBe('x,y');
    // a width is still rejected, exactly as before the regex was narrowed
    expect(resolveRef(['local', 'padded'], at)).toBe(UNKNOWN);
  });

  /** A `%` followed by a long zero run and no verb letter used to make the
   *  flags/width alternation backtrack quadratically: 40k zeros measured 2.7s,
   *  per hover, on a template that can arrive from a resolved local. */
  it('does not backtrack on a long run of zeros in a format template', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile(
      '/re/locals.tf',
      ['locals {', `  bad = format("%${'0'.repeat(40_000)}!", "x")`, '}', ''].join('\n'),
    );
    const started = Date.now();
    expect(resolveRef(['local', 'bad'], { index, moduleDir: '/re' })).toBe(UNKNOWN);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/** A reference that gave up because a budget ran out used to be forgotten, so
 *  every later lookup of it ran the whole evaluation again. In a ladder where each
 *  level reads the one below twice, the levels past the budget each doubled the
 *  work of the level under them: 17 levels of `concat(x, x)` fit the budget, and
 *  every level after that cost twice the one before. Measured on this parser:
 *  the 30-level ladder below took 32,783 expression reads, and a 40-level one
 *  was still running after three minutes — a synchronous loop on the extension
 *  host, so the hover's cancellation token could not even be read. */
describe('a reference that ran out of budget is evaluated once', () => {
  const ladder = (levels: number): string => {
    const lines = ['locals {', '  a0 = ["leaf"]'];
    for (let i = 1; i <= levels; i++)
      lines.push(`  a${i} = concat(local.a${i - 1}, local.a${i - 1})`);
    lines.push('}', '');
    return lines.join('\n');
  };

  it('does not repeat the evaluation of a level that already gave up', async () => {
    const index = new WorkspaceIndex();
    const levels = 30;
    await index.updateFile('/gaveup/locals.tf', ladder(levels));
    const at: EvalScope = { index, moduleDir: '/gaveup' };

    // every expression the evaluator reads goes through this one door
    const reads = vi.spyOn(parser, 'withExpressionNode');
    try {
      expect(resolveRef(['local', `a${levels}`], at)).toBe(UNKNOWN);
      // one read per local is the floor; the doubling made it 32,783
      expect(reads.mock.calls.length).toBeLessThan(100);
    } finally {
      reads.mockRestore();
    }
  });

  it('still reports the list as unmeasured, not as absent', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('/gaveup/shape.tf', ladder(30));
    // the answer the count -> for_each safety check reads: an unmeasured list must
    // never be certified, however the evaluation got to giving up
    expect(listShape('local.a30', { index, moduleDir: '/gaveup' })).toEqual({
      kind: 'unknown',
      overBudget: true,
    });
  });

  /** The same ladder under a chain longer than the reference-hop limit: the walk
   *  gives up at the limit before any budget is spent, so what stops the doubling
   *  there is not the element budget at all. */
  it('does not repeat the evaluation of a level that gave up at the hop limit', async () => {
    const index = new WorkspaceIndex();
    const chain = 258;
    const levels = 9;
    const lines = ['locals {', '  a0 = ["leaf"]'];
    for (let i = 1; i <= chain; i++) lines.push(`  a${i} = local.a${i - 1}`);
    for (let i = chain + 1; i <= chain + levels; i++) {
      lines.push(`  a${i} = concat(local.a${i - 1}, local.a${i - 1})`);
    }
    lines.push('}', '');
    await index.updateFile('/gaveup/hops.tf', lines.join('\n'));

    const reads = vi.spyOn(parser, 'withExpressionNode');
    try {
      const top = `a${chain + levels}`;
      expect(resolveRef(['local', top], { index, moduleDir: '/gaveup' })).toBe(UNKNOWN);
      // every level read once is the floor; the doubling made it ~130,000
      expect(reads.mock.calls.length).toBeLessThan(2000);
    } finally {
      reads.mockRestore();
    }
  });

  /** The one shape the memos above cannot recognise: every level reaches the next
   *  through two different locals (`x = local.d`, `y = local.d`, `d' = concat(x, y)`),
   *  under a chain longer than the hop limit. The give-up is about where the walk
   *  stands, so it is remembered only for the very frame that met it, and the two
   *  locals are two frames: the work doubled at every level, and a few hundred
   *  lines of HCL — generated, or written to be opened — held the extension host
   *  for as long as it cared to. A resolve now has a number of reference
   *  evaluations it may start, whatever shape they come in. */
  it('stops a resolve that keeps evaluating after its budget of references is spent', async () => {
    const index = new WorkspaceIndex();
    const chain = 260;
    const levels = 8;
    const lines = ['locals {', '  c0 = ["leaf"]'];
    for (let i = 1; i <= chain; i++) lines.push(`  c${i} = local.c${i - 1}`);
    lines.push(`  d0 = local.c${chain}`);
    for (let j = 1; j <= levels; j++) {
      lines.push(`  x${j} = local.d${j - 1}`, `  y${j} = local.d${j - 1}`);
      lines.push(`  d${j} = concat(local.x${j}, local.y${j})`);
    }
    lines.push('}', '');
    await index.updateFile('/diamond/locals.tf', lines.join('\n'));
    const at: EvalScope = { index, moduleDir: '/diamond' };

    const reads = vi.spyOn(parser, 'withExpressionNode');
    try {
      const text = resolveRef(['local', `d${levels}`], at);
      // unbounded, every one of the 2^levels paths walks the chain again, and each
      // added level doubles that (14 levels did not finish); the cap is 20,000
      // evaluations, so what is left is that plus the unwinding
      expect(reads.mock.calls.length).toBeLessThan(25_000);
      expect(text).toContain(UNKNOWN);
    } finally {
      reads.mockRestore();
    }
    // spent is not the same as absent: nothing certifies a rewrite on it
    expect(listShape(`local.d${levels}`, at)).not.toMatchObject({ kind: 'strings' });
  });

  /** A reference a budget gave up on reads as the text ⟨unknown⟩ when it sits in an
   *  interpolation, so `["${local.hot}", "x"]` is two strings — and two strings
   *  that look different, when `hot` is really "x". The list was never measured,
   *  which the count -> for_each check must read as "cannot certify": toset()
   *  would collapse the real duplicates while count built them all. */
  it('does not certify a list that holds an element the hop limit gave up on', async () => {
    const index = new WorkspaceIndex();
    const lines = ['locals {', '  c0 = "x"'];
    for (let i = 1; i <= 260; i++) lines.push(`  c${i} = local.c${i - 1}`);
    lines.push('  hot = local.c260', '  names = ["${local.hot}", "x"]', '}', '');
    await index.updateFile('/certify/hops.tf', lines.join('\n'));
    expect(listShape('local.names', { index, moduleDir: '/certify' })).toEqual({
      kind: 'unknown',
      overBudget: true,
    });
  });

  /** The same through the cap on reference evaluations: the elements past it are
   *  given up on, and a list of strings that looks unique is not one. */
  it('does not certify a list that holds an element the evaluation cap gave up on', async () => {
    const index = new WorkspaceIndex();
    const count = 20_100;
    const lines = ['locals {'];
    for (let i = 0; i < count; i++) lines.push(`  v${i} = "x${i}"`);
    const elements = Array.from({ length: count }, (_, i) => `"\${local.v${i}}"`);
    lines.push(`  names = [${elements.join(', ')}]`, '}', '');
    await index.updateFile('/certify/cap.tf', lines.join('\n'));
    expect(listShape('local.names', { index, moduleDir: '/certify' })).toEqual({
      kind: 'unknown',
      overBudget: true,
    });
  });

  /** The number it may start is a ceiling on pathological work, not a limit anyone
   *  meets: with the memo, a resolve evaluates each distinct reference once, and
   *  this reads five thousand of them. */
  it('leaves a resolve that needs thousands of distinct references alone', async () => {
    const index = new WorkspaceIndex();
    const count = 5000;
    const lines = ['locals {'];
    for (let i = 0; i < count; i++) lines.push(`  v${i} = "x${i}"`);
    lines.push(`  all = [${Array.from({ length: count }, (_, i) => `local.v${i}`).join(', ')}]`);
    lines.push('}', '');
    await index.updateFile('/wide/locals.tf', lines.join('\n'));
    const shape = listShape('local.all', { index, moduleDir: '/wide' });
    expect(shape.kind).toBe('strings');
    if (shape.kind === 'strings') expect(shape.values).toHaveLength(count);
  });

  /** `MAX_DEPTH` counts module call hops, so it is another limit a reference can run
   *  into from where the walk stands and not from what it is. Thirteen modules
   *  each passing the next a value, with ladders in some that run the budget out,
   *  and an expression reading the same variables twice: the second read of a
   *  variable once showed ⟨unknown⟩ where the walk had since resolved part of it,
   *  because the first read's give-up had been remembered for good. Pinned to what
   *  the evaluator showed before anything was remembered. */
  it('shows what a fresh evaluation shows for a variable read twice near the depth limit', async () => {
    const ladder = (levels: number): string => {
      const lines = ['  L0 = ["x", "y"]'];
      for (let i = 1; i <= levels; i++)
        lines.push(`  L${i} = concat(local.L${i - 1}, local.L${i - 1})`);
      return [...lines, `  big = local.L${levels}`].join('\n');
    };
    // [ladder levels, v passed to the next module, w passed to it]
    const modules: [number, string, string?][] = [
      [18, '"${var.v}-${local.x}"'],
      [17, 'var.w'],
      [18, 'local.big'],
      [0, 'local.big'],
      [0, '[var.v, local.big]'],
      [17, 'concat(local.big, local.big)', 'var.w'],
      [0, 'var.v', '"${var.v}-${local.x}"'],
      [0, '"${var.v}-${local.x}"', 'lower(var.v)'],
      [0, 'join(",", var.w)', 'local.y'],
      [0, 'var.v', '[var.v, local.big]'],
      [0, '[var.v, local.big]', '[var.v, local.big]'],
      [0, 'local.y'],
      [0, 'local.y', 'concat(local.big, local.big)'],
      [0, ''],
    ];
    const index = new WorkspaceIndex();
    for (const [i, [levels, v, w]] of modules.entries()) {
      const variables =
        i === 0
          ? 'variable "v" {\n  default = "rv"\n}\nvariable "w" {\n  default = ["r1", "r2"]\n}\n'
          : 'variable "v" {}\nvariable "w" {\n  default = "dw"\n}\n';
      const locals = `locals {\n  x = "x${i}"\n  y = [local.x, var.w]\n${
        levels > 0 ? ladder(levels) : '  big = "small"'
      }\n}\n`;
      const call = v
        ? `module "n" {\n  source = "../m${i + 1}"\n  v = ${v}\n${w ? `  w = ${w}\n` : ''}}\n`
        : '';
      await index.updateFile(`/depth/m${i}/main.tf`, variables + locals + call);
    }
    const twice = '[var.v, var.w, local.y, var.v, local.big, var.w]';
    expect(resolveExpr(twice, { index, moduleDir: '/depth/m9' })).toBe(
      `[${UNKNOWN}, ${UNKNOWN}, [x9, [x8, ${UNKNOWN}]], ${UNKNOWN}, small, [x8, ${UNKNOWN}]]`,
    );
  });

  /** Remembering a give-up must also leave the same trail a second evaluation
   *  would have: `used.calls` is rendered in the hover as `via module …`. Read at a
   *  shallower depth than the first time, a variable ran the budget out; read
   *  deeper, the module-hop limit would have cut it first and the walk back up
   *  would have recorded each call it passed through. */
  it('records the same module calls for a variable read at two different depths', async () => {
    const index = new WorkspaceIndex();
    const twenty = `[${Array.from({ length: 20 }, () => '"z"').join(', ')}]`;
    await index.updateFile(
      '/r/m1/main.tf',
      `module "n1" {\n  source = "../m2"\n  a = ${twenty}\n}\n`,
    );
    for (const i of [2, 3, 4]) {
      await index.updateFile(
        `/r/m${i}/main.tf`,
        `variable "a" {}\nmodule "n${i}" {\n  source = "../m${i + 1}"\n  a = var.a\n}\n`,
      );
    }
    await index.updateFile(
      '/r/m5/main.tf',
      'variable "a" {}\nlocals {\n  r = var.a\n}\nmodule "n5" {\n  source = "../m6"\n  b6 = local.r\n  f6 = var.a\n}\n',
    );
    await index.updateFile(
      '/r/m6/main.tf',
      'variable "b6" {}\nvariable "f6" {}\nlocals {\n  q = var.b6\n}\nmodule "n6" {\n  source = "../m7"\n  c = local.q\n  e = var.f6\n}\n',
    );
    await index.updateFile('/r/m7/main.tf', 'variable "c" {}\nvariable "e" {}\n');
    // enough elements to leave no budget for what is read after them
    const drain = `[${Array.from({ length: 99_990 }, () => '1').join(',')}]`;
    const used = emptyUsage();
    resolveExpr(`[${drain}, var.c, var.e]`, { index, moduleDir: '/r/m7', used });
    expect([...used.calls]).toEqual([1, 2, 3, 4, 5, 6].map((n) => `module "n${n}" (main.tf)`));
  });

  /** The same trail where the walk comes back round on itself: two modules that
   *  call each other, and a chain of locals long enough to hit the hop limit before
   *  the loop closes. Read again from inside the other chain, the loop is closed by
   *  a reference already in progress, which counts for nothing, and the calls were
   *  recorded all the same. */
  it('records the same module calls when the second read is inside a loop', async () => {
    const index = new WorkspaceIndex();
    const chain = (prefix: string, length: number, end: string): string =>
      Array.from(
        { length },
        (_, i) => `  ${prefix}${i} = ${i + 1 < length ? `local.${prefix}${i + 1}` : end}`,
      ).join('\n');
    await index.updateFile(
      '/loop/m1/main.tf',
      `variable "b" {}\nlocals {\n${chain('c', 100, 'var.b')}\n}\nmodule "to2" {\n  source = "../m2"\n  a = local.c0\n}\n`,
    );
    await index.updateFile(
      '/loop/m2/main.tf',
      `variable "a" {}\nlocals {\n${chain('d', 100, 'var.a')}\n${chain('x', 100, 'var.a')}\n}\nmodule "to1" {\n  source = "../m1"\n  b = local.d0\n}\n`,
    );
    const used = emptyUsage();
    resolveExpr('[local.x0, local.d0]', { index, moduleDir: '/loop/m2', used });
    expect([...used.calls]).toEqual(['module "to1" (main.tf)', 'module "to2" (main.tf)']);
  });

  /** What is remembered must be what a second evaluation would have said. A give-up
   *  that came from where the walk stood (this chain is longer than the hop limit
   *  only when read from its top) says nothing about the reference itself, and a
   *  later lookup from nearer must still resolve it. */
  it('does not remember a give-up that depended on how deep the lookup was', async () => {
    const index = new WorkspaceIndex();
    const lines = ['locals {'];
    for (let i = 0; i < 299; i++) lines.push(`  c${i} = local.c${i + 1}`);
    lines.push('  c299 = "leaf"', '  both = [local.c0, local.c100]', '}', '');
    await index.updateFile('/gaveup/depth.tf', lines.join('\n'));
    expect(resolveRef(['local', 'both'], { index, moduleDir: '/gaveup' })).toBe(
      `[${UNKNOWN}, leaf]`,
    );
  });
});

/** `inProgress` stops a cycle but bounds an honest chain only at "distinct
 *  references in the module", and each hop is four real JS frames. A generated
 *  ladder overflowed the stack, and the RangeError escaped provideHover. */
describe('a very long reference chain', () => {
  it('resolves to unknown instead of throwing a stack overflow', async () => {
    const index = new WorkspaceIndex();
    const depth = 3000;
    const lines = ['locals {'];
    for (let i = 0; i < depth; i++) lines.push(`  c${i} = local.c${i + 1}`);
    lines.push(`  c${depth} = "leaf"`, '}', '');
    await index.updateFile('/deep/locals.tf', lines.join('\n'));

    expect(() => resolveRef(['local', 'c0'], { index, moduleDir: '/deep' })).not.toThrow();
    expect(resolveRef(['local', 'c0'], { index, moduleDir: '/deep' })).toBe(UNKNOWN);
  });

  it('still resolves a chain of ordinary length', async () => {
    const index = new WorkspaceIndex();
    const lines = ['locals {'];
    for (let i = 0; i < 30; i++) lines.push(`  c${i} = local.c${i + 1}`);
    lines.push('  c30 = "leaf"', '}', '');
    await index.updateFile('/shallow/locals.tf', lines.join('\n'));
    expect(resolveRef(['local', 'c0'], { index, moduleDir: '/shallow' })).toBe('leaf');
  });
});

/** Structural recursion used to pass `depth` down unchanged, so MAX_DEPTH
 *  bounded reference hops and nothing else: a nested collection literal
 *  recursed until V8 threw RangeError, and provideHover does not catch it, so
 *  one generated .tf took the hover down for the whole document. */
describe('nesting cannot overflow the stack', () => {
  it.each([50, 200, 600, 1500, 3000])('survives %i levels of nesting', (levels) => {
    const expr = `${'['.repeat(levels)}"x"${']'.repeat(levels)}`;
    expect(() => resolveExpr(expr, scope)).not.toThrow();
  });

  it('survives deep nesting reached through a reference', async () => {
    const index = new WorkspaceIndex();
    const deep = `${'['.repeat(400)}"x"${']'.repeat(400)}`;
    await index.updateFile('/deep/l.tf', `locals {\n  a = ${deep}\n  b = local.a\n}\n`);
    const s: EvalScope = { index, moduleDir: '/deep', tfvarsOf: tfvarsIn('/deep', {}) };
    expect(() => resolveRef(['local', 'b'], s)).not.toThrow();
  });

  /** The cap must not clip shapes the current release resolves: a 26-level
   *  concat ladder peaks at 84 live frames, a 250-hop chain at 1003. */
  it('still resolves a long reference chain', async () => {
    const index = new WorkspaceIndex();
    const lines = ['locals {', '  c0 = "x"'];
    for (let i = 1; i <= 250; i++) lines.push(`  c${i} = "\${local.c${i - 1}}"`);
    lines.push('}');
    await index.updateFile('/chain/l.tf', lines.join('\n'));
    const s: EvalScope = { index, moduleDir: '/chain', tfvarsOf: tfvarsIn('/chain', {}) };
    expect(resolveRef(['local', 'c250'], s)).toBe('x');
  });

  it('resolves supported block context and leaves unsupported context unknown', async () => {
    const index = new WorkspaceIndex();
    const source = 'resource "x" "item" {\n  count = 3\n  name = "${count.index}"\n}\n';
    await index.updateFile('/context/main.tf', source);
    const block = parseFile('/context/main.tf', source).blocks[0];
    if (!block) throw new Error('test fixture did not parse a resource block');
    const s: EvalScope = { index, moduleDir: '/context' };
    const instances = resolveContext(block, s);
    expect(instances?.at(-1)?.countIndex).toBe(2);
    expect(resolveRef(['count', 'index'], { ...s, context: instances?.[1] })).toBe('1');
    expect(resolveRef(['self', 'id'], { ...s, context: instances?.[1] })).toBe(UNKNOWN);
  });

  it('accepts only map and set collections for for_each', async () => {
    const index = new WorkspaceIndex();
    const source = 'resource "x" "item" {\n  for_each = ["a", "b"]\n}\n';
    await index.updateFile('/context/list.tf', source);
    const listBlock = parseFile('/context/list.tf', source).blocks[0];
    if (!listBlock) throw new Error('test fixture did not parse a resource block');
    expect(resolveContext(listBlock, { index, moduleDir: '/context' })).toBeUndefined();

    const setSource = 'resource "x" "item" {\n  for_each = toset(["a", "b"])\n}\n';
    await index.updateFile('/context/set.tf', setSource);
    const setBlock = parseFile('/context/set.tf', setSource).blocks[0];
    if (!setBlock) throw new Error('test fixture did not parse a resource block');
    expect(resolveContext(setBlock, { index, moduleDir: '/context' })).toHaveLength(2);
  });

  it('rejects oversized for_each maps and attribute tails on context values', async () => {
    const entries = Array.from({ length: 65 }, (_, i) => `k${i} = "${i}"`).join(', ');
    const index = new WorkspaceIndex();
    const source = `resource "x" "item" {\n  for_each = { ${entries} }\n}\n`;
    await index.updateFile('/context/map.tf', source);
    const block = parseFile('/context/map.tf', source).blocks[0];
    if (!block) throw new Error('test fixture did not parse a resource block');
    const scope: EvalScope = {
      index,
      moduleDir: '/context',
      context: { label: 'x', countIndex: 0 },
    };
    expect(resolveContext(block, scope)).toBeUndefined();
    expect(resolveRef(['count', 'index', 'tail'], scope)).toBe(UNKNOWN);
    expect(resolveRef(['path', 'module', 'tail'], { ...scope, context: undefined })).toBe(UNKNOWN);
  });

  it('rejects dynamic or unknown map entries as a whole', async () => {
    const index = new WorkspaceIndex();
    const source =
      'variable "value" {}\nresource "x" "item" {\n  for_each = { known = "ok", dynamic = var.value }\n}\n';
    await index.updateFile('/context/dynamic.tf', source);
    const block = parseFile('/context/dynamic.tf', source).blocks[1];
    if (!block) throw new Error('test fixture did not parse a resource block');
    expect(resolveContext(block, { index, moduleDir: '/context' })).toBeUndefined();
  });

  it('stops context evaluation when cancelled', async () => {
    const index = new WorkspaceIndex();
    const source = 'resource "x" "item" {\n  for_each = { a = "one", b = "two" }\n}\n';
    await index.updateFile('/context/cancel.tf', source);
    const block = parseFile('/context/cancel.tf', source).blocks[0];
    if (!block) throw new Error('test fixture did not parse a resource block');
    let checks = 0;
    expect(
      resolveContext(
        block,
        { index, moduleDir: '/context' },
        {
          isCancelled: () => ++checks > 1,
        },
      ),
    ).toBeUndefined();
  });

  it('does not treat ordinary or nested blocks as Terraform instance blocks', async () => {
    const index = new WorkspaceIndex();
    const source = 'locals {\n  nested {\n    count = 2\n  }\n}\n';
    await index.updateFile('/context/ordinary.tf', source);
    const block = parseFile('/context/ordinary.tf', source).blocks[0];
    if (!block) throw new Error('test fixture did not parse a block');
    expect(resolveContext(block, { index, moduleDir: '/context' })).toBeUndefined();
    const nested = block.blocks[0];
    if (!nested) throw new Error('test fixture did not parse nested block');
    expect(resolveContext(nested, { index, moduleDir: '/context' })).toBeUndefined();
  });
});

describe('context values', () => {
  async function resource(source: string) {
    const index = new WorkspaceIndex();
    await index.updateFile('/context/main.tf', source);
    const block = parseFile('/context/main.tf', source).blocks.find((b) => b.kind === 'resource');
    if (!block) throw new Error('fixture has no resource block');
    return { index, block, s: { index, moduleDir: '/context' } as EvalScope };
  }

  /** Values share structure: a local read twice is one object. Converting one as
   *  a tree doubles the work with every level, so a 24-line chain of locals froze
   *  the extension host. */
  it('does not expand a shared value as a tree', async () => {
    // deep enough that expanding the shared structure as a tree takes seconds, not
    // the fraction of one that a slower machine could blame
    const levels = 26;
    const chain = ['a0 = ["x", "x"]'];
    for (let i = 1; i <= levels; i++) chain.push(`a${i} = [local.a${i - 1}, local.a${i - 1}]`);
    const { block, s } = await resource(
      `locals {\n${chain.map((l) => `  ${l}`).join('\n')}\n}\nresource "x" "r" {\n  for_each = { k = local.a${levels} }\n}\n`,
    );
    const started = performance.now();
    const instances = resolveContext(block, s);
    resolveRef(['each', 'value'], { ...s, context: instances?.[0] });
    expect(performance.now() - started).toBeLessThan(500);
    expect(instances).toHaveLength(1);
  });

  it('keeps numbers exactly as written', async () => {
    const { block, s } = await resource(
      'resource "x" "r" {\n  for_each = { k = { a = 12345678901234567890, b = 100000000000000000000000, c = 0.1234567890123456789 } }\n}\n',
    );
    const [instance] = resolveContext(block, s) ?? [];
    for (const [key, literal] of [
      ['a', '12345678901234567890'],
      ['b', '100000000000000000000000'],
      ['c', '0.1234567890123456789'],
    ] as const) {
      expect(resolveRef(['each', 'value', key], { ...s, context: instance })).toBe(
        resolveExpr(literal, s),
      );
    }
  });

  it('keeps a key named __proto__', async () => {
    const { block, s } = await resource(
      'resource "x" "r" {\n  for_each = { k = { "__proto__" = "p", real = "r" } }\n}\n',
    );
    const [instance] = resolveContext(block, s) ?? [];
    expect(resolveRef(['each', 'value', '__proto__'], { ...s, context: instance })).toBe('p');
    expect(resolveRef(['each', 'value', 'real'], { ...s, context: instance })).toBe('r');
  });

  it('accepts a for_each map of exactly 64 entries and rejects 65', async () => {
    const map = (n: number) =>
      `resource "x" "r" {\n  for_each = { ${Array.from({ length: n }, (_, i) => `k${i} = "${i}"`).join(', ')} }\n}\n`;
    const sixtyFour = await resource(map(64));
    expect(resolveContext(sixtyFour.block, sixtyFour.s)).toHaveLength(64);
    const sixtyFive = await resource(map(65));
    expect(resolveContext(sixtyFive.block, sixtyFive.s)).toBeUndefined();
  });

  it('reads an unresolved element of a set as unknown, the way it does for a list', () => {
    const asList = listShape('[var.region, "a"]', scope);
    expect(asList.kind).toBe('unknown');
    expect(listShape('toset([var.region, "a"])', scope)).toEqual(asList);
  });

  /** An explicit root answers "which directory is the root". It cannot speak for a
   *  module that another root owns, so there the root is found from the files. */
  it('uses an explicit root only for the modules it applies to', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile(
      '/repo/envs/prod/main.tf',
      'module "vpc" {\n  source = "../../modules/vpc"\n}\n',
    );
    await index.updateFile('/repo/envs/dev/main.tf', 'locals {}\n');
    await index.updateFile('/repo/modules/vpc/main.tf', 'locals {}\n');
    const base = { index, rootDir: '/repo/envs/prod', cwd: '/run/prod' };

    const dev: EvalScope = { ...base, moduleDir: '/repo/envs/dev' };
    expect(resolveRef(['path', 'module'], dev)).toBe('.');
    const assumed = emptyUsage();
    expect(resolveRef(['path', 'cwd'], { ...dev, used: assumed })).toBe('/repo/envs/dev');
    expect(assumed.assumes.size).toBe(1);

    const prod: EvalScope = { ...base, moduleDir: '/repo/envs/prod' };
    expect(resolveRef(['path', 'module'], prod)).toBe('.');
    expect(resolveRef(['path', 'cwd'], prod)).toBe('/run/prod');
    const vpc: EvalScope = { ...base, moduleDir: '/repo/modules/vpc' };
    expect(resolveRef(['path', 'module'], vpc)).toBe('../../modules/vpc');
  });

  /** One window can hold several roots, and a single terraformCwd describes only
   *  one run. `terraform -chdir=` may point anywhere, so no relation between the
   *  run directory and a root can be checked: what can be said is that, with
   *  several roots and no terraformRoot to say which one the setting belongs to,
   *  the setting is applied to all of them as an assumption. */
  it('says a configured path.cwd is an assumption for a root among several', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/envs/dev/main.tf', 'locals {}\n');
    await index.updateFile('/ws/envs/prod/main.tf', 'locals {}\n');
    const used = emptyUsage();
    const scope: EvalScope = { index, moduleDir: '/ws/envs/dev', cwd: '/run/prod', used };
    expect(resolveRef(['path', 'cwd'], scope)).toBe('/run/prod');
    expect([...used.assumes].join()).toContain('terraformCwd');
  });

  it('takes a configured path.cwd at its word when there is a single root', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/main.tf', 'module "m" {\n  source = "./m"\n}\n');
    await index.updateFile('/ws/m/main.tf', 'locals {}\n');
    const used = emptyUsage();
    expect(resolveRef(['path', 'cwd'], { index, moduleDir: '/ws/m', cwd: '/run', used })).toBe(
      '/run',
    );
    expect(used.assumes.size).toBe(0);
  });

  /** VS Code spells a Windows drive letter in lower case; a setting is spelled as
   *  it was typed. */
  it('compares configured directories without regard to the case of a drive letter', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('c:/ws/envs/prod/main.tf', 'locals {}\n');
    const used = emptyUsage();
    const scope: EvalScope = {
      index,
      moduleDir: 'c:/ws/envs/prod',
      rootDir: 'C:/ws/envs/prod',
      cwd: 'C:/ws',
      used,
    };
    expect(resolveRef(['path', 'cwd'], scope)).toBe('C:/ws');
    expect(used.assumes.size).toBe(0);
  });

  describe('which root a module belongs to', () => {
    const workspace = async (files: Record<string, string>) => {
      const index = new WorkspaceIndex();
      for (const [path, text] of Object.entries(files)) await index.updateFile(path, text);
      return index;
    };
    const call = (name: string, source: string) =>
      `module "${name}" {\n  source = "${source}"\n}\n`;

    it('finds the one root above a module that two of its modules both call', async () => {
      const index = await workspace({
        '/r/main.tf': call('b', './b') + call('c', './c'),
        '/r/b/main.tf': call('d', '../d'),
        '/r/c/main.tf': call('d', '../d'),
        '/r/d/main.tf': 'locals {}\n',
      });
      expect(resolveRef(['path', 'module'], { index, moduleDir: '/r/d' })).toBe('d');
    });

    it('is not thrown by modules that call each other', async () => {
      const index = await workspace({
        '/r/main.tf': call('a', './a') + call('b', './b'),
        '/r/a/main.tf': call('b', '../b'),
        '/r/b/main.tf': call('a', '../a'),
      });
      expect(resolveRef(['path', 'module'], { index, moduleDir: '/r/a' })).toBe('a');
    });

    const twoRoots = {
      '/repo/envs/prod/main.tf': call('vpc', '../../modules/vpc'),
      '/repo/envs/dev/main.tf': call('vpc', '../../modules/vpc'),
      '/repo/modules/vpc/main.tf': 'locals {}\n',
    };

    it('claims nothing for a module two roots reach, since path.module differs between them', async () => {
      const index = await workspace(twoRoots);
      const scope: EvalScope = { index, moduleDir: '/repo/modules/vpc' };
      expect(resolveRef(['path', 'module'], scope)).toBe(UNKNOWN);
    });

    it('lets an explicit root settle a module two roots reach', async () => {
      const index = await workspace(twoRoots);
      const scope: EvalScope = {
        index,
        moduleDir: '/repo/modules/vpc',
        rootDir: '/repo/envs/prod',
      };
      expect(resolveRef(['path', 'module'], scope)).toBe('../../modules/vpc');
    });
  });

  /** The note is for a window that really holds several roots. A directory that
   *  has only a .tfvars file is not a module, so it is not one. */
  it('does not count a directory holding only tfvars as a second root', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('/repo/main.tf', 'locals {}\n');
    await index.updateFile('/repo/environments/prod.tfvars', 'x = 1\n');
    const used = emptyUsage();
    const scope: EvalScope = { index, moduleDir: '/repo', cwd: '/run', used };
    expect(resolveRef(['path', 'cwd'], scope)).toBe('/run');
    expect(used.assumes.size).toBe(0);
  });

  /** An example that calls the module it sits in is a root of its own: it is run
   *  from its own directory. Roots are told apart the way `rootDirOf` tells them,
   *  by the calls from outside a module's own tree. */
  it('counts an example that calls its own module as a second root', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('/lib/main.tf', 'locals {}\n');
    await index.updateFile(
      '/lib/examples/basic/main.tf',
      'module "lib" {\n  source = "../.."\n}\n',
    );
    const used = emptyUsage();
    expect(resolveRef(['path', 'cwd'], { index, moduleDir: '/lib', cwd: '/run', used })).toBe(
      '/run',
    );
    expect([...used.assumes].join()).toContain('terraformCwd');
  });

  /** A hover can evaluate path.cwd once per row, and counting the roots walks the
   *  whole index. */
  it('counts the roots once for as long as the index does not change', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('/ws/a/main.tf', 'locals {}\n');
    await index.updateFile('/ws/b/main.tf', 'locals {}\n');
    const files = vi.spyOn(index, 'files');
    const scope: EvalScope = { index, moduleDir: '/ws/a', cwd: '/run', used: emptyUsage() };
    resolveRef(['path', 'cwd'], scope);
    resolveRef(['path', 'cwd'], scope);
    expect(files).toHaveBeenCalledTimes(1);
    await index.updateFile('/ws/c/main.tf', 'locals {}\n');
    resolveRef(['path', 'cwd'], scope);
    expect(files).toHaveBeenCalledTimes(2);
  });

  describe('configured directories against the index', () => {
    const matches = async (indexed: string, rootDir: string): Promise<boolean> => {
      const index = new WorkspaceIndex();
      await index.updateFile(`${indexed}/main.tf`.replace(/^\/\//, '/'), 'locals {}\n');
      const used = emptyUsage();
      const scope: EvalScope = {
        index,
        moduleDir: index.moduleDirOf(`${indexed}/main.tf`.replace(/^\/\//, '/')),
        rootDir,
        cwd: '/run',
        used,
      };
      const value = resolveRef(['path', 'cwd'], scope);
      return value === '/run' && used.assumes.size === 0;
    };

    it('matches a root at the root of the file system, which the index spells empty', async () => {
      expect(await matches('', '/')).toBe(true);
      expect(await matches('c:', 'C:/')).toBe(true);
    });

    it('keeps two directories that differ only in case apart', async () => {
      expect(await matches('/ws/envs/prod', '/WS/envs/prod')).toBe(false);
      expect(await matches('/ws/envs/prod', '/ws/envs/prod')).toBe(true);
    });

    it('stops the climb at an explicit root that another module calls', async () => {
      const index = new WorkspaceIndex();
      await index.updateFile(
        'c:/ws/envs/prod/main.tf',
        'module "m" {\n  source = "../../modules/m"\n}\n',
      );
      await index.updateFile('c:/ws/modules/m/main.tf', 'locals {}\n');
      const scope: EvalScope = {
        index,
        moduleDir: 'c:/ws/modules/m',
        rootDir: 'C:/ws/modules/m',
      };
      expect(resolveRef(['path', 'module'], scope)).toBe('.');
    });
  });
});
