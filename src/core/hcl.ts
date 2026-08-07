import type { Pos, Span, TfBlock } from './model';

export function stripQuotes(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

export function spanContains(span: Span, pos: Pos): boolean {
  if (pos.row < span.start.row || pos.row > span.end.row) return false;
  if (pos.row === span.start.row && pos.column < span.start.column) return false;
  if (pos.row === span.end.row && pos.column > span.end.column) return false;
  return true;
}

/** `spanContains` with the end treated as exclusive, which is how tree-sitter
 *  reports it.
 *
 *  For a block the inclusive end is what you want — the closing brace is part
 *  of the block. For a *token* it is one column too generous: `var.a` spanning
 *  columns 6-11 occupies 6-10, so the inclusive test also claimed column 11 —
 *  the `}` in `"${var.env}"`, or the space after the reference — and the hover
 *  popped one character past its target. */
export function spanContainsExclusiveEnd(span: Span, pos: Pos): boolean {
  if (!spanContains(span, pos)) return false;
  return !(pos.row === span.end.row && pos.column === span.end.column);
}

export function attrOf(block: TfBlock, name: string): TfBlock['attrs'][number] | undefined {
  return block.attrs.find((a) => a.name === name);
}

export function nestedBlock(block: TfBlock, kind: string): TfBlock | undefined {
  return block.blocks.find((b) => b.kind === kind);
}

/** Depth-first visit of every block and its nested blocks. */
export function walkBlocks(blocks: TfBlock[], visit: (b: TfBlock) => void): void {
  for (const b of blocks) {
    visit(b);
    walkBlocks(b.blocks, visit);
  }
}

/** A line's text with its comments removed, for look-ahead that asks "is there
 *  anything meaningful left here". `#` and `//` run to the end of the line;
 *  `/*` can close and be followed by real code, and if it doesn't close on this
 *  line the remainder is comment too.
 *
 *  Deliberately not a lexer: it does not know a `#` inside a string literal
 *  from a real comment. Both callers scan the text *after* a reference and use
 *  the result only to decide whether to withhold a fix, so the worst a
 *  misreading does is withhold one — never offer an edit it shouldn't. */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('#', i) || text.startsWith('//', i)) break;
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    out += text[i++];
  }
  return out;
}

export interface TextEdit {
  span: Span;
  newText: string;
}
