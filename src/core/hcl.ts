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

export interface TextEdit {
  span: Span;
  newText: string;
}
