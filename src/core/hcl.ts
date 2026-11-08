import type { Pos, Span, TfBlock, TfRef } from './model';

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

/** `a` comes strictly before `b` in the document. */
function before(a: Pos, b: Pos): boolean {
  return a.row < b.row || (a.row === b.row && a.column < b.column);
}

/** Whether an array of references is in document order, remembered per array. The
 *  parser emits them as it walks the tree, so it is — but the answer is checked
 *  rather than assumed, because the fast path below is only correct if it holds,
 *  and one O(n) pass per parse is nothing next to the parse. */
const orderedRefs = new WeakMap<readonly TfRef[], boolean>();

function inDocumentOrder(refs: readonly TfRef[]): boolean {
  let ordered = orderedRefs.get(refs);
  if (ordered === undefined) {
    ordered = true;
    for (let i = 1; i < refs.length; i++) {
      const prev = refs[i - 1];
      const next = refs[i];
      if (prev && next && before(next.span.start, prev.span.start)) {
        ordered = false;
        break;
      }
    }
    orderedRefs.set(refs, ordered);
  }
  return ordered;
}

/** The references that start inside `span` — `refs.filter(r =>
 *  spanContains(span, r.span.start))`, in the same order, without reading the
 *  rest.
 *
 *  The filter was written inline at every call site, once per block, and that
 *  made each detector O(blocks × references) for a file: `dependsOn` measured
 *  31ms at 4000 lines and 131ms at 8000, `count = length(...)` 15ms and 60ms —
 *  quadratic, where parsing the same files was linear. Both run on every
 *  debounced keystroke, and again from the code-action provider on every cursor
 *  move. References come out of the parser in document order, so the ones inside
 *  a block are one contiguous run and a binary search finds where it starts.
 *
 *  The end is inclusive, like `spanContains`. An array that is not in document
 *  order gets the plain filter, so the result is never different — only slower. */
export function refsStartingIn(refs: readonly TfRef[], span: Span): TfRef[] {
  if (!inDocumentOrder(refs)) return refs.filter((r) => spanContains(span, r.span.start));
  let lo = 0;
  let hi = refs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const ref = refs[mid];
    if (ref && before(ref.span.start, span.start)) lo = mid + 1;
    else hi = mid;
  }
  const out: TfRef[] = [];
  for (let i = lo; i < refs.length; i++) {
    const ref = refs[i];
    if (!ref || before(span.end, ref.span.start)) break;
    out.push(ref);
  }
  return out;
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
