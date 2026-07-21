import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ParsedFile } from '../src/core/model';
import { parseFile, withExpressionNode } from '../src/core/parser';
import { fixturePath, initTestParser } from './helpers';

let file: ParsedFile;

beforeAll(async () => {
  await initTestParser();
  file = parseFile('main.tf', readFileSync(fixturePath('simple', 'main.tf'), 'utf8'));
});

describe('parser core', () => {
  it('extracts top-level blocks with kinds and labels', () => {
    const kinds = file.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['terraform', 'locals', 'resource']);
    const resource = file.blocks[2]!;
    expect(resource.labels).toEqual(['aws_db_instance', 'main']);
    expect(resource.span.start.row).toBe(13);
  });

  it('surfaces required_providers entries as provider_requirement blocks', () => {
    const terraform = file.blocks[0]!;
    const rp = terraform.blocks.find((b) => b.kind === 'required_providers')!;
    const aws = rp.blocks.find((b) => b.kind === 'provider_requirement')!;
    expect(aws.labels).toEqual(['aws']);
    const version = aws.attrs.find((a) => a.name === 'version')!;
    expect(version.valueText).toBe('"~> 5.34.0"');
    expect(version.valueSpan.start.row).toBe(4);
  });

  it('extracts attributes with value spans', () => {
    const resource = file.blocks[2]!;
    const count = resource.attrs.find((a) => a.name === 'count')!;
    expect(count.valueText).toBe('length(var.lista)');
    expect(count.valueSpan.start.row).toBe(15);
  });

  it('extracts nested blocks', () => {
    const resource = file.blocks[2]!;
    const lifecycle = resource.blocks.find((b) => b.kind === 'lifecycle')!;
    expect(lifecycle.attrs[0]!.name).toBe('prevent_destroy');
    expect(lifecycle.attrs[0]!.valueText).toBe('true');
  });

  it('extracts multi-part references with positions, excluding bare identifiers', () => {
    const varLista = file.refs.filter((r) => r.parts.join('.') === 'var.lista');
    expect(varLista.length).toBe(2);
    expect(file.refs.some((r) => r.parts.join('.') === 'local.name_prefix')).toBe(true);
    expect(file.refs.some((r) => r.parts.join('.') === 'count.index')).toBe(true);
    expect(file.refs.some((r) => r.parts.join('.') === 'var.env')).toBe(true);
    // object keys like `source` / `version` must not be refs
    expect(file.refs.every((r) => r.parts.length >= 2)).toBe(true);
    const varEnv = file.refs.find((r) => r.parts.join('.') === 'var.env')!;
    expect(varEnv.span.start.row).toBe(10);
  });

  it('parses tfvars-style top-level attributes as tfvars_entry blocks', () => {
    const tfvars = parseFile('dev.tfvars', 'env = "dev"\nreplicas = 2\n');
    expect(tfvars.blocks.map((b) => [b.kind, b.labels[0]])).toEqual([
      ['tfvars_entry', 'env'],
      ['tfvars_entry', 'replicas'],
    ]);
  });
});

describe('a value the grammar cannot parse must not become a confident one', () => {
  // "1e3" is valid HCL (1000), but the grammar rejects the exponent — it
  // used to recover as port = 1 plus a phantom e3 swallowing the next line
  it('drops both halves of a value split by error recovery', () => {
    const f = parseFile('a.tf', 'locals {\n  port = 1e3\n  ok   = 42\n}\n');
    const locals = f.blocks.find((b) => b.kind === 'locals')!;
    expect(locals.attrs.map((a) => a.name)).not.toContain('port');
    expect(locals.attrs.map((a) => a.name)).not.toContain('e3');
  });

  it('keeps every attribute of a file that parses cleanly', () => {
    const f = parseFile('a.tf', 'locals {\n  port = 1000\n  ok   = 42\n}\n');
    const locals = f.blocks.find((b) => b.kind === 'locals')!;
    expect(locals.attrs.map((a) => [a.name, a.valueText])).toEqual([
      ['port', '1000'],
      ['ok', '42'],
    ]);
  });

  it('withExpressionNode rejects a partial parse instead of returning its prefix', () => {
    expect(withExpressionNode('1e3', (n) => n.text)).toBeUndefined();
    expect(withExpressionNode('1000', (n) => n.text)).toBe('1000');
  });

  // "a = 1# note" is complete, valid HCL, not a chopped value — the
  // zero-gap heuristic must not swallow it and drop the attribute
  it('keeps an attribute whose value a comment touches with no space', () => {
    const f = parseFile(
      'a.tf',
      'locals {\n  a = 1# note\n  b = 2// note\n  c = 3/* note */\n  d = 4 # spaced\n}\n',
    );
    const locals = f.blocks.find((b) => b.kind === 'locals')!;
    expect(locals.attrs.map((a) => [a.name, a.valueText])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
      ['d', '4'],
    ]);
  });

  it('keeps a tfvars entry whose value a comment touches with no space', () => {
    const f = parseFile('dev.tfvars', 'env = "prod"# forced\n');
    expect(f.blocks.map((b) => [b.kind, b.labels[0]])).toEqual([['tfvars_entry', 'env']]);
  });
});
