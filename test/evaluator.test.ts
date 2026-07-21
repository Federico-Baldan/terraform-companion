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
