import { beforeAll, describe, expect, it } from 'vitest';
import { type EvalScope, resolveExpr, resolveRef, UNKNOWN } from '../src/core/evaluator';
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
});
