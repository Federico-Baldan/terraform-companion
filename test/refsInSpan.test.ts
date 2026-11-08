import { beforeAll, describe, expect, it } from 'vitest';
import { refsStartingIn, spanContains, walkBlocks } from '../src/core/hcl';
import type { ParsedFile, Span, TfRef } from '../src/core/model';
import { parseFile } from '../src/core/parser';
import { initTestParser } from './helpers';

beforeAll(initTestParser);

/** What every caller did before: scan all of a file's references per block. */
const viaFilter = (refs: readonly TfRef[], span: Span) =>
  refs.filter((r) => spanContains(span, r.span.start));

const SRC = `variable "names" {
  default = ["a", "b"]
}

locals {
  env  = var.env
  tags = merge(local.base, { Env = local.env })
}

resource "aws_instance" "web" {
  count      = length(var.names)
  name       = "x-\${var.names[count.index]}"
  tags       = local.tags
  subnet_id  = aws_subnet.main.id
  depends_on = [aws_subnet.main]

  lifecycle {
    ignore_changes = [tags]
  }
}

resource "aws_subnet" "main" {
  vpc_id = aws_vpc.main.id
}

output "ids" {
  value = aws_instance.web[*].id
}
`;

function allSpans(file: ParsedFile): Span[] {
  const spans: Span[] = [];
  walkBlocks(file.blocks, (b) => {
    spans.push(b.span, b.bodySpan);
    for (const a of b.attrs) spans.push(a.span, a.valueSpan);
  });
  return spans;
}

const pos = (row: number, column: number) => ({ row, column });

describe('refsStartingIn', () => {
  it('equals the linear filter for every block and attribute span of a real file', () => {
    const file = parseFile('/w/main.tf', SRC);
    const spans = allSpans(file);
    expect(spans.length).toBeGreaterThan(20);
    expect(file.refs.length).toBeGreaterThan(10);
    for (const span of spans) {
      expect(refsStartingIn(file.refs, span)).toEqual(viaFilter(file.refs, span));
    }
  });

  it('equals the linear filter for arbitrary spans, including empty and out-of-range ones', () => {
    const file = parseFile('/w/main.tf', SRC);
    const rows = SRC.split('\n').length;
    for (let r1 = -1; r1 <= rows + 1; r1 += 2) {
      for (let r2 = r1; r2 <= rows + 1; r2 += 3) {
        for (const c1 of [0, 5, 40]) {
          for (const c2 of [0, 7, 80]) {
            const span: Span = { start: pos(r1, c1), end: pos(r2, c2) };
            // a span that ends before it starts matches nothing either way
            if (r1 === r2 && c2 < c1) continue;
            expect(refsStartingIn(file.refs, span)).toEqual(viaFilter(file.refs, span));
          }
        }
      }
    }
  });

  it('treats the end as inclusive, exactly as spanContains does', () => {
    const refs: TfRef[] = [
      { parts: ['var', 'a'], span: { start: pos(1, 4), end: pos(1, 9) } },
      { parts: ['var', 'b'], span: { start: pos(1, 10), end: pos(1, 15) } },
      { parts: ['var', 'c'], span: { start: pos(1, 11), end: pos(1, 16) } },
    ];
    const span: Span = { start: pos(1, 4), end: pos(1, 10) };
    expect(refsStartingIn(refs, span).map((r) => r.parts[1])).toEqual(['a', 'b']);
  });

  it('keeps the order of the array it is given, and hands back a fresh one', () => {
    const file = parseFile('/w/main.tf', SRC);
    const whole: Span = { start: pos(0, 0), end: pos(1000, 0) };
    const got = refsStartingIn(file.refs, whole);
    expect(got).toEqual(file.refs);
    expect(got).not.toBe(file.refs);
    got.length = 0;
    expect(refsStartingIn(file.refs, whole)).toHaveLength(file.refs.length);
  });

  it('falls back to the linear filter when the references are not in document order', () => {
    const file = parseFile('/w/main.tf', SRC);
    // reversed: a binary search over this would silently return nothing useful
    const shuffled = [...file.refs].reverse();
    for (const span of allSpans(file).slice(0, 25)) {
      expect(refsStartingIn(shuffled, span)).toEqual(viaFilter(shuffled, span));
    }
  });

  it('is empty for no references', () => {
    expect(refsStartingIn([], { start: pos(0, 0), end: pos(5, 5) })).toEqual([]);
  });

  /** The fast path is only taken when this holds, so a parser change that broke
   *  document order would cost speed and never correctness — but this is where
   *  that would be noticed. */
  it('finds the parser emitting references in document order', () => {
    for (const src of [SRC, 'x = [for a in var.l : a.id if local.f]\ny = "${var.a}${var.b}"\n']) {
      const refs = parseFile('/w/a.tf', src).refs;
      const ordered = refs.every((r, i) => {
        const prev = refs[i - 1];
        if (!prev) return true;
        const a = prev.span.start;
        const b = r.span.start;
        return a.row < b.row || (a.row === b.row && a.column <= b.column);
      });
      expect(ordered).toBe(true);
    }
  });
});
