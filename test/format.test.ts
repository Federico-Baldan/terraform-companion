import { beforeAll, describe, expect, it } from 'vitest';
import { type EvalScope, resolveExpr, UNKNOWN } from '../src/core/evaluator';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { initTestParser } from './helpers';

let scope: EvalScope;

beforeAll(async () => {
  await initTestParser();
  const index = new WorkspaceIndex();
  await index.updateFile(
    '/mod/main.tf',
    [
      'locals {',
      '  a    = "A"',
      '  b    = "B"',
      '  port = 8080',
      '  frac = 1.5',
      '  list = ["x", "y"]',
      '  obj  = { k = "v" }',
      '}',
      '',
    ].join('\n'),
  );
  scope = { index, moduleDir: '/mod' };
});

const ev = (expr: string) => resolveExpr(expr, scope);

describe('format(): verbs go-cty reproduces exactly', () => {
  it('%s substitutes positionally', () => {
    expect(ev('format("%s-%s", local.a, local.b)')).toBe('A-B');
  });

  it('%v behaves as %s for primitives', () => {
    expect(ev('format("%v-%v", local.a, local.b)')).toBe('A-B');
  });

  it('mixes %v and %s without shifting the argument list', () => {
    // the regression: this used to resolve to the wrong string "%v-A"
    expect(ev('format("%v-%s", local.a, local.b)')).toBe('A-B');
  });

  it('%d renders a whole number', () => {
    expect(ev('format("port %d", local.port)')).toBe('port 8080');
    // cty converts a numeric string for %d, so this is reproducible too
    expect(ev('format("port %d", "8443")')).toBe('port 8443');
  });

  it('%q quotes', () => {
    expect(ev('format("%q", local.a)')).toBe('"A"');
  });

  it('%% is a literal percent and consumes no argument', () => {
    expect(ev('format("100%% of %s", local.a)')).toBe('100% of A');
  });

  it('honours an explicit argument index', () => {
    expect(ev('format("%[1]s-%[1]s", local.a)')).toBe('A-A');
    expect(ev('format("%[2]s-%[1]s", local.a, local.b)')).toBe('B-A');
  });

  it('an explicit index also moves the implicit counter, as in Go', () => {
    expect(ev('format("%[2]s%s", local.a, local.b, local.a)')).toBe('BA');
  });
});

describe('format(): everything not reproducible resolves to unknown', () => {
  const unknown = [
    // padding and precision would need Go's exact fmt behaviour
    ['width', 'format("%5s", local.a)'],
    ['left-align', 'format("%-10s|", local.a)'],
    ['zero pad', 'format("%05d", local.port)'],
    ['precision', 'format("%.2f", local.port)'],
    // verbs go-cty accepts but we do not reproduce
    ['float', 'format("%f", local.port)'],
    ['hex', 'format("%x", local.port)'],
    ['bool', 'format("%t", local.a)'],
    // go-cty errors on these
    ['unknown verb', 'format("%y", local.a)'],
    // %d requires a whole number: 1.5 and "A" are plan-time errors in cty
    ['%d on a fraction', 'format("%d", local.frac)'],
    ['%d on text', 'format("%d", local.a)'],
    ['stray percent', 'format("50% off %s", local.a)'],
    ['trailing percent', 'format("done %s %", local.a)'],
    ['index out of range', 'format("%[3]s", local.a)'],
    ['too few arguments', 'format("%s-%s", local.a)'],
    // collections are not stringifiable by %s/%v here
    ['list argument', 'format("%s", local.list)'],
    ['object argument', 'format("%v", local.obj)'],
    // an argument that never resolved must not silently vanish
    ['unresolved argument', 'format("%s", var.nope)'],
  ] as const;

  for (const [name, expr] of unknown) {
    it(`${name} → ${UNKNOWN}`, () => {
      expect(ev(expr)).toBe(UNKNOWN);
    });
  }
});

describe('format(): no template text is lost', () => {
  it('keeps literal text around the verbs', () => {
    expect(ev('format("<<%s|%s>>", local.a, local.b)')).toBe('<<A|B>>');
  });

  it('keeps a trailing literal', () => {
    expect(ev('format("%s tail", local.a)')).toBe('A tail');
  });

  it('handles a template with no verbs at all', () => {
    expect(ev('format("plain")')).toBe('plain');
  });
});
