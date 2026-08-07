import {
  type EvalScope,
  emptyUsage,
  type ListShape,
  listShape,
  type TfvarsValue,
} from '../core/evaluator';
import { attrOf, spanContains, stripComments, type TextEdit } from '../core/hcl';
import type { LintFinding, ParsedFile, Span, TfAttr, TfBlock } from '../core/model';
import type { ModuleCallSite, WorkspaceIndex } from '../core/workspaceIndex';

export interface CountPattern {
  blockSpan: Span;
  countAttr: TfAttr;
  listRef: string[];
  /** the list expression text, e.g. "var.lista" */
  refText: string;
  /** spans covering `var.lista[count.index]` occurrences (including the index) */
  indexUses: Span[];
  /** false when the rewrite would change what Terraform builds. Computed
   *  lazily, so a caller that only wants the diagnostic never pays for it. */
  readonly safeToRefactor: boolean;
}

// HCL identifiers allow dashes, so `length(var.my-list)` is legal
const LENGTH_CALL = /^length\(\s*((?:var|local)\.[\w-]+)\s*\)$/;
/** HCL allows padding inside the brackets and terraform fmt keeps it. */
const INDEX_SUFFIX = /^\[\s*count\.index\s*\]/;

/** address parts other expressions use to reference the block:
 *  resource → ["aws_x", "y"], data → ["data", "aws_x", "y"], module → ["module", "y"] */
function addressParts(block: TfBlock): string[] | undefined {
  if (block.kind === 'resource') {
    return block.labels.length >= 2
      ? [block.labels[0] as string, block.labels[1] as string]
      : undefined;
  }
  if (block.kind === 'data') {
    return block.labels.length >= 2
      ? ['data', block.labels[0] as string, block.labels[1] as string]
      : undefined;
  }
  return block.labels[0] ? ['module', block.labels[0]] : undefined;
}

/** for_each takes a map or set of strings, so objects are a plan-time error.
 *  Undeclared type stays refactorable — `any` is the common case. */
const STRING_COLLECTION = /^(?:list|set)\(\s*string\s*\)$/;

/** An element read into again — `.field`, `["field"]`, `[0]` are all the same
 *  op, and any of them means it's a collection, not a string. */
const ELEMENT_ACCESS = /^\s*(?:\.\s*[\w-]|\[)/;

/** Blank remainders continue onto the next line — HCL lets the accessor sit
 *  there. Scanning ahead can only withhold the fix, not wrongly offer it. */
/** Functions whose first argument must be a collection, so an element passed
 *  there is itself a map or list — which `for_each` rejects at plan time.
 *
 *  A whitelist of *dangerous* callees rather than a blanket "any function
 *  argument": the callee is what carries the evidence. `upper(x)` proves the
 *  element is a string and stays refactorable; `lookup(x, …)` proves it is a
 *  map and must not be. Treating both the same withheld correct refactors. */
const COLLECTION_ARG_FUNCS = new Set([
  'lookup',
  'merge',
  'keys',
  'values',
  'element',
  'flatten',
  'concat',
  'coalescelist',
  'compact',
  'distinct',
  'reverse',
  'sort',
  'slice',
  'chunklist',
  'setunion',
  'setintersection',
  'setsubtract',
  'transpose',
  'zipmap',
  'sum',
  'one',
]);

/** Callee name when the element sits directly in that function's first
 *  argument slot — there is no accessor to find in that position, so the
 *  accessor scan below cannot see the shape at all. */
const COLLECTION_CALL = /([\w-]+)\s*\($/;

function usedAsCollectionArgument(file: ParsedFile, uses: Span[]): boolean {
  return uses.some((use) => {
    let before = stripComments((file.lines[use.start.row] ?? '').slice(0, use.start.column));
    for (let row = use.start.row; before.trim() === '' && row > 0; ) {
      before = stripComments(file.lines[--row] ?? '');
    }
    const callee = COLLECTION_CALL.exec(before.trimEnd())?.[1];
    return callee !== undefined && COLLECTION_ARG_FUNCS.has(callee);
  });
}

function usedAsObject(file: ParsedFile, uses: Span[]): boolean {
  return uses.some((use) => {
    // comments skip like blanks — a comment between the element and its
    // accessor hid the accessor, and the refactor was then offered on a list of
    // objects that for_each rejects
    let rest = stripComments((file.lines[use.end.row] ?? '').slice(use.end.column));
    for (let row = use.end.row; rest.trim() === '' && row + 1 < file.lines.length; ) {
      rest = stripComments(file.lines[++row] ?? '');
    }
    // an accessor can sit past the closing paren of a grouping — one paren was
    // enough to defeat this scan: `(\n  var.people[count.index]\n).name`
    return ELEMENT_ACCESS.test(rest) || ELEMENT_ACCESS.test(rest.replace(/^\s*\)+/, ''));
  });
}

/** Only a bare reference passes a declared type through unchanged — anything
 *  that computes a value (literal list, concat(), interpolation) stops the walk. */
const BARE_REF = /^((?:var|local)\.[\w-]+)$/;

function aliasTarget(listRef: string[], file: ParsedFile, index: WorkspaceIndex): string[] {
  const locals = index.localsOf(index.moduleDirOf(file.path));
  const seen = new Set<string>();
  let ref = listRef;
  while (ref[0] === 'local' && ref[1] && !seen.has(ref[1])) {
    seen.add(ref[1]); // locals defined in terms of each other must not spin
    const next = locals
      .find((l) => l.name === ref[1])
      ?.attr.valueText.trim()
      .match(BARE_REF);
    if (!next?.[1]) break;
    ref = next[1].split('.');
  }
  return ref;
}

/** true when the list's declared type is known and cannot produce string keys */
function declaredNonStringElements(
  rawRef: string[],
  file: ParsedFile,
  index: WorkspaceIndex | undefined,
): boolean {
  if (!index) return false;
  const listRef = aliasTarget(rawRef, file, index);
  if (listRef[0] !== 'var' || !listRef[1]) return false;
  const variable = index.variablesOf(index.moduleDirOf(file.path)).get(listRef[1]);
  const type = variable && attrOf(variable.block, 'type');
  if (!type) return false; // undeclared: Terraform treats it as `any`
  return !STRING_COLLECTION.test(type.valueText.replace(/\s+/g, ' ').trim());
}

/** true when the list's declared type proves its elements are strings — the one
 *  case where handing an element to a function says nothing about its shape. */
function declaredStringElements(
  rawRef: string[],
  file: ParsedFile,
  index: WorkspaceIndex | undefined,
): boolean {
  if (!index) return false;
  const listRef = aliasTarget(rawRef, file, index);
  if (listRef[0] !== 'var' || !listRef[1]) return false;
  const variable = index.variablesOf(index.moduleDirOf(file.path)).get(listRef[1]);
  const type = variable && attrOf(variable.block, 'type');
  if (!type) return false;
  return STRING_COLLECTION.test(type.valueText.replace(/\s+/g, ' ').trim());
}

/** Judging a `var.*` list by its default is the wrong question — a tfvars
 *  file exists to override it, and duplicates there are what toset() collapses. */
export interface TfvarsContext {
  tfvarsOf: (moduleDir: string) => ReadonlyMap<string, TfvarsValue>;
}

/** Non-string elements have no valid for_each key; a repeated value collapses
 *  via toset() into one instance, quietly building fewer resources than count. */
function shapeUnusable(shape: ListShape): boolean {
  if (shape.kind === 'nonStrings') return true;
  // A list the evaluator gave up measuring is not a list we can certify. It is
  // reported the same way as one it cannot reach, but the two need opposite
  // answers here: `concat` doubling past the element budget is exactly how a
  // list of thousands of identical strings arrives, and toset() would collapse
  // it to one instance while count built them all.
  if (shape.kind === 'unknown') return shape.overBudget === true;
  return new Set(shape.values).size !== shape.values.length;
}

/** A list the evaluator can't reach concludes nothing here — the declared-type
 *  and usage checks cover that case.
 *
 *  A multi-instantiated module has no single list, so each instance is checked
 *  separately and any one unusable withholds the fix. Recursion matters: the
 *  evaluator only reports the first divergence it meets, so a value forwarded
 *  through two of them needs a second pinned pass to reach. */
function resolvedListUnusable(
  refText: string,
  file: ParsedFile,
  index: WorkspaceIndex | undefined,
  tfvars: TfvarsContext | undefined,
  pinnedSites: Map<string, ModuleCallSite> = new Map(),
): boolean {
  if (!index) return false;
  const base: EvalScope = {
    index,
    moduleDir: index.moduleDirOf(file.path),
    tfvarsOf: tfvars?.tfvarsOf,
  };
  const used = emptyUsage();
  const shape = listShape(refText, { ...base, used, pinnedSites });
  const diverged = used.divergedAt;
  if (!diverged) return shapeUnusable(shape);
  return diverged.sites.some((site) =>
    resolvedListUnusable(
      refText,
      file,
      index,
      tfvars,
      new Map([...pinnedSites, [diverged.moduleDir, site]]),
    ),
  );
}

/** After the rewrite, an outside reference (web[0], web[*], depends_on) would
 *  index a map by number and break. */
function referencedOutsideBlock(
  file: ParsedFile,
  block: TfBlock,
  index: WorkspaceIndex | undefined,
): boolean {
  const addr = addressParts(block);
  if (!addr) return false;
  const matches = (parts: string[]) =>
    parts.length >= addr.length && addr.every((p, i) => parts[i] === p);
  if (file.refs.some((r) => matches(r.parts) && !spanContains(block.span, r.span.start))) {
    return true;
  }
  if (!index) return false;
  const moduleDir = index.moduleDirOf(file.path);
  // Scanning ahead can only withhold the fix, not wrongly offer it — and a
  // sibling that does not currently parse makes "nothing references this"
  // unknowable rather than false. Without this, an unterminated string in
  // `outputs.tf` (open, mid-edit, never saved) erases its `aws_instance.srv[0]`
  // reference from the index, the rewrite is offered and taken, and the moment
  // the typo is fixed the config breaks with "Invalid index" in a different
  // file, well past the undo horizon.
  if (index.moduleHasParseError(moduleDir)) return true;
  // Ask for the two-part address and narrow here. `refsTo` only uses its
  // precomputed bucket when given exactly two parts, and a data source's
  // address is three (`data.type.name`) — so this fell through to a scan of
  // every reference in every indexed file, on the code-action path, which VS
  // Code drives from cursor movement. Resources and modules were already
  // bucketed; only data blocks went off the cliff.
  return index
    .refsTo(addr.slice(0, 2))
    .some(
      (u) =>
        matches(u.ref.parts) && u.file !== file.path && index.moduleDirOf(u.file) === moduleDir,
    );
}

export function detectCountLength(
  file: ParsedFile,
  index?: WorkspaceIndex,
  tfvars?: TfvarsContext,
): CountPattern[] {
  const patterns: CountPattern[] = [];
  for (const block of file.blocks) {
    // data sources take `count` too, with the same index-shift hazard
    if (block.kind !== 'resource' && block.kind !== 'data' && block.kind !== 'module') continue;
    const countAttr = attrOf(block, 'count');
    if (!countAttr) continue;
    const m = countAttr.valueText.trim().match(LENGTH_CALL);
    if (!m?.[1]) continue;
    const refText = m[1];
    const listRef = refText.split('.');
    const indexUses: Span[] = [];
    for (const ref of file.refs) {
      if (!spanContains(block.span, ref.span.start)) continue;
      if (ref.parts.length !== listRef.length || !ref.parts.every((p, i) => p === listRef[i])) {
        continue;
      }
      const line = file.lines[ref.span.end.row] ?? '';
      const suffix = INDEX_SUFFIX.exec(line.slice(ref.span.end.column));
      if (suffix) {
        indexUses.push({
          start: ref.span.start,
          end: { row: ref.span.end.row, column: ref.span.end.column + suffix[0].length },
        });
      }
    }
    if (indexUses.length > 0) {
      // deferred until safeToRefactor is first read — only the quick fix needs
      // it, and this detector reruns on every keystroke. Eager, it cost ~100x
      // the detection itself for a result most callers discard. Memoised so
      // the provider that does read it computes it once.
      const currentBlock = block;
      let safety: boolean | undefined;
      patterns.push({
        blockSpan: block.span,
        countAttr,
        listRef,
        refText,
        indexUses,
        get safeToRefactor(): boolean {
          if (safety === undefined) {
            const orphanedIndexUse = file.refs.some(
              (ref) =>
                ref.parts[0] === 'count' &&
                ref.parts[1] === 'index' &&
                spanContains(currentBlock.span, ref.span.start) &&
                !indexUses.some((use) => spanContains(use, ref.span.start)),
            );
            safety =
              // The buffer being rewritten, not just its indexed copy. The
              // module-level guard inside referencedOutsideBlock only consults
              // the index, which is debounced and up to 500ms stale — so an
              // unterminated string typed anywhere in *this* file made
              // tree-sitter error-recover and drop the very
              // `aws_instance.srv[0]` reference that must withhold the fix,
              // while the index still held the clean copy and answered "no
              // parse error". The rewrite then landed on a file whose remaining
              // references it could not see.
              !file.hasError &&
              !orphanedIndexUse &&
              !referencedOutsideBlock(file, currentBlock, index) &&
              !usedAsObject(file, indexUses) &&
              // a collection-consuming callee only condemns an element whose
              // type is not already proven to be a string
              !(
                usedAsCollectionArgument(file, indexUses) &&
                !declaredStringElements(listRef, file, index)
              ) &&
              !declaredNonStringElements(listRef, file, index) &&
              !resolvedListUnusable(refText, file, index, tfvars);
          }
          return safety;
        },
      });
    }
  }
  return patterns;
}

export function countFinding(p: CountPattern): LintFinding {
  return {
    code: 'count.lengthPattern',
    message:
      'Removing an element from the middle of the list recreates every resource after it. Use for_each. Note: toset() drops duplicate values and needs a list of strings; already-applied resources need `terraform state mv`.',
    span: p.countAttr.span,
  };
}

export function rewriteToForEach(p: CountPattern): TextEdit[] {
  const nameSpan: Span = {
    start: p.countAttr.span.start,
    end: {
      row: p.countAttr.span.start.row,
      column: p.countAttr.span.start.column + 'count'.length,
    },
  };
  const edits: TextEdit[] = [
    { span: nameSpan, newText: 'for_each' },
    { span: p.countAttr.valueSpan, newText: `toset(${p.refText})` },
    ...p.indexUses.map((span) => ({ span, newText: 'each.value' })),
  ];
  return edits;
}
