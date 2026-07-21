import { attrOf, spanContains, stripQuotes, walkBlocks } from '../core/hcl';
import type { LintFinding, ParsedFile, Span, TfRef } from '../core/model';

const DEPENDABLE = new Set(['resource', 'data', 'module', 'output']);

/** Entries of a depends_on tuple. Comments are dropped so they never become
 *  bogus entries. */
function parseEntries(valueText: string): string[] {
  const inner = valueText.trim().replace(/^\[/, '').replace(/\]$/, '');
  const noComments = inner
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?:#|\/\/).*/, ''))
    .join('\n');
  return noComments
    .split(',')
    .map((e) => stripQuotes(e.trim()))
    .filter((e) => e.length > 0);
}

/** Splicing an entry out of a one-entry-per-line tuple leaves an empty line. */
function dropBlankedLine(text: string, at: number): string {
  // at === 0 has no preceding newline — lastIndexOf treats a negative start
  // as 0, which would wrongly match one
  const lineStart = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', lineStart);
  const lineEnd = nl === -1 ? text.length : nl;
  if (text.slice(lineStart, lineEnd).trim() !== '') return text;
  return text.slice(0, lineStart) + text.slice(nl === -1 ? lineEnd : nl + 1);
}

/** Entries are parsed comment-free but the fix splices raw text, so an
 *  address that also appears in a comment must not match there first. */
function commentRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\/\*[\s\S]*?\*\/|(?:#|\/\/)[^\n]*/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** Splice one entry out of the raw tuple text instead of rebuilding from the
 *  parsed list, which would flatten the layout and delete every comment. A
 *  trailing comment on the removed entry goes with it. */
function removeEntry(text: string, entry: string): string {
  const esc = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // never match as the prefix of a longer address (incl. "["): depends_on
  // accepts instance addresses, so bare aws_x.y must not match inside
  // aws_x.y[0]. Comma-adjacent spaces go too, so [a, b] leaves [b], not [ b]
  const re = new RegExp(`(?<![\\w.\\-])"?${esc}"?(?![\\w.\\-\\[])[ \\t]*(,)?[ \\t]*`, 'g');
  const comments = commentRanges(text);
  const inComment = (at: number) => comments.some(([from, to]) => at >= from && at < to);
  // the first match that is a real entry, not a mention inside a comment
  let m = re.exec(text);
  while (m !== null && inComment(m.index)) m = re.exec(text);
  if (!m) return text;
  let start = m.index;
  let end = m.index + m[0].length;
  if (!m[1]) {
    // last entry: the comma separating it from the previous one is now dangling
    const before = text.slice(0, start);
    const comma = before.lastIndexOf(',');
    if (comma !== -1 && before.slice(comma + 1).trim() === '') start = comma;
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (text.slice(lineStart, start).trim() === '') {
    const nl = text.indexOf('\n', end);
    const rest = text.slice(end, nl === -1 ? text.length : nl);
    if (/^\s*(?:#|\/\/)/.test(rest)) end += rest.length;
  }
  return dropBlankedLine(text.slice(0, start) + text.slice(end), start);
}

/** collectRefs stops a reference at the first index, so parts alone can't
 *  tell aws_x.y from aws_x.y[0] — the text after the span can. */
const ANY_INDEX = /^\s*\[/;
const SPLAT_INDEX = /^\s*\[\s*\*\s*\]/;

/** Whether a reference reaches every instance — what a bare
 *  `depends_on = [aws_x.y]` waits for.
 *
 *  Terraform folds the index into the reference's subject, so aws_x.y[0].id
 *  depends on just that instance: dropping the bare depends_on there would
 *  narrow the edge and let the block build before the rest of count exists.
 *  `[*]` is the exception, reading the whole set. An unrecognised index reads
 *  as narrowing, so the fix is withheld. */
function coversAllInstances(file: ParsedFile, ref: TfRef): boolean {
  let rest = (file.lines[ref.span.end.row] ?? '').slice(ref.span.end.column);
  for (let row = ref.span.end.row; rest.trim() === '' && row + 1 < file.lines.length; ) {
    rest = file.lines[++row] ?? '';
  }
  return ANY_INDEX.test(rest) ? SPLAT_INDEX.test(rest) : true;
}

/** Whether the entry address is already referenced — for every instance — by
 *  an expression inside the block. */
function isImplicit(entry: string, refs: TfRef[], file: ParsedFile): boolean {
  const parts = entry.split('.');
  if (parts.length < 2) return false;
  return refs.some(
    (r) =>
      r.parts.length >= parts.length &&
      parts.every((p, i) => r.parts[i] === p) &&
      coversAllInstances(file, r),
  );
}

/** Swallowing whole lines is only safe when the attribute is their sole
 *  occupant — HCL allows `depends_on = [a]` sharing a line with `{` or a
 *  trailing `] }`, where a line delete would take a brace with it. */
function deletionSpan(file: ParsedFile, span: Span): Span {
  const before = (file.lines[span.start.row] ?? '').slice(0, span.start.column);
  const after = (file.lines[span.end.row] ?? '').slice(span.end.column);
  if (before.trim() !== '' || after.trim() !== '') return span;
  // take the trailing newline too, or the leading one on the last line
  if (span.end.row + 1 < file.lines.length) {
    return { start: { row: span.start.row, column: 0 }, end: { row: span.end.row + 1, column: 0 } };
  }
  if (span.start.row > 0) {
    const prev = span.start.row - 1;
    return {
      start: { row: prev, column: (file.lines[prev] ?? '').length },
      end: { row: span.end.row, column: (file.lines[span.end.row] ?? '').length },
    };
  }
  return {
    start: { row: span.start.row, column: 0 },
    end: { row: span.end.row, column: (file.lines[span.end.row] ?? '').length },
  };
}

/** Entries whose target the block's own arguments already reference. */
export function detectRedundantDependsOn(file: ParsedFile): LintFinding[] {
  const findings: LintFinding[] = [];
  walkBlocks(file.blocks, (block) => {
    if (!DEPENDABLE.has(block.kind)) return;
    const attr = attrOf(block, 'depends_on');
    if (!attr?.valueText.trim().startsWith('[')) return;
    const entries = parseEntries(attr.valueText);
    if (entries.length === 0) return;

    // block references, excluding the depends_on tuple itself
    const bodyRefs = file.refs.filter(
      (r) => spanContains(block.bodySpan, r.span.start) && !spanContains(attr.span, r.span.start),
    );
    // module addresses are never redundant — [module.x] waits for everything
    // in it, while module.x.output waits only for what that output needs
    const redundant = entries.filter(
      (e) => !e.startsWith('module.') && isImplicit(e, bodyRefs, file),
    );
    if (redundant.length === 0) return;

    const kept = entries.filter((e) => !redundant.includes(e));
    const fix =
      kept.length === 0
        ? { span: deletionSpan(file, attr.span), newText: '' }
        : {
            // edits only the tuple's own text — attribute name, spacing
            // around =, and surrounding layout aren't this fix's business
            span: attr.valueSpan,
            newText: redundant.reduce(removeEntry, attr.valueText),
          };
    findings.push({
      code: 'dependsOn.redundant',
      message:
        redundant.length === 1
          ? `Redundant depends_on: ${redundant[0]} is already referenced in the block's arguments (implicit dependency).`
          : `Redundant depends_on: ${redundant.join(', ')} are already referenced in the block's arguments (implicit dependencies).`,
      span: attr.span,
      fix,
    });
  });
  return findings;
}
