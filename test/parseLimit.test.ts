import { beforeAll, describe, expect, it } from 'vitest';
import { parseFile, withExpressionNode } from '../src/core/parser';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { detectUnusedLocals } from '../src/features/unusedLocals';
import { initTestParser } from './helpers';

beforeAll(initTestParser);

/** The largest source handed to tree-sitter, in characters. Written out here on
 *  purpose: it is a contract with the user's machine, and changing it should mean
 *  changing this line. Parsing costs about 0.9s and 150MB per MB of source, in a
 *  WebAssembly heap that stops at 2GB — a file past ~10MB used to take the parser
 *  down for the rest of the session, and one of a few MB froze the extension host
 *  for seconds on every edit. */
const LIMIT = 1_048_576;

const BLOCK = 'resource "aws_instance" "web" {\n  ami = "x"\n}\n';

/** A source of exactly `length` characters that holds one real block: padded with
 *  a comment, which costs the lexer next to nothing. */
function sourceOfLength(length: number, tail = ''): string {
  const pad = length - BLOCK.length - tail.length - 3;
  return `${BLOCK}# ${'x'.repeat(pad)}\n${tail}`;
}

describe('a file past the parse limit', () => {
  it('is parsed as usual up to the limit', () => {
    const source = sourceOfLength(LIMIT);
    expect(source).toHaveLength(LIMIT);
    const parsed = parseFile('/limit/at.tf', source);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.hasError).toBe(false);
    expect(parsed.tooLarge).toBeUndefined();
  });

  it('is not parsed, and is reported as incomplete rather than as empty', () => {
    const source = sourceOfLength(LIMIT + 1);
    const parsed = parseFile('/limit/over.tf', source);
    expect(parsed.tooLarge).toBe(true);
    // "what I can see is a floor, not the whole truth": the answer every consumer
    // already reads as "withhold", and the one that keeps an unread reference from
    // being taken for an absent one
    expect(parsed.hasError).toBe(true);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.refs).toEqual([]);
    // the text stays: the index tells a real edit from a re-read of the same bytes
    // by comparing it
    expect(parsed.source).toBe(source);
    expect(parsed.lines[0]).toBe('resource "aws_instance" "web" {');
  });

  it('does not push a file the extension is using out of the parse memo', () => {
    const small = 'locals {\n  a = 1\n}\n';
    const first = parseFile('/limit/small.tf', small);
    parseFile('/limit/huge.tf', sourceOfLength(LIMIT + 1));
    expect(parseFile('/limit/small.tf', small)).toBe(first);
  });

  it('keeps the module from claiming a local is unused', async () => {
    const index = new WorkspaceIndex();
    await index.updateFile('/limit/mod/locals.tf', 'locals {\n  name = "x"\n}\n');
    // the only reference to local.name is in the file nobody read
    await index.updateFile(
      '/limit/mod/main.tf',
      sourceOfLength(LIMIT + 1, 'output "o" {\n  value = local.name\n}\n'),
    );
    expect(index.moduleHasParseError('/limit/mod')).toBe(true);
    expect(detectUnusedLocals(index, '/limit/mod')).toEqual([]);
  });

  it('is not indexed twice for the same bytes', async () => {
    const index = new WorkspaceIndex();
    const source = sourceOfLength(LIMIT + 1);
    expect(await index.updateFile('/limit/twice.tf', source)).toBe(true);
    expect(await index.updateFile('/limit/twice.tf', source)).toBe(false);
  });

  it('is not handed to the expression parser either', () => {
    let used = false;
    const expr = `[${'1,'.repeat(LIMIT / 2)}1]`;
    expect(expr.length).toBeGreaterThan(LIMIT);
    expect(
      withExpressionNode(expr, () => {
        used = true;
        return 1;
      }),
    ).toBeUndefined();
    expect(used).toBe(false);
  });
});
