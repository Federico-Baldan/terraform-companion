import { Language, type Node, Parser } from 'web-tree-sitter';
import { stripComments, stripQuotes } from './hcl';
import type { ParsedFile, Span, TfAttr, TfBlock, TfRef } from './model';

let language: Language | undefined;
let parser: Parser | undefined;

export interface ParserWasmPaths {
  runtimeWasm: string;
  grammarWasm: string;
}

/** In flight, so overlapping callers await the same init instead of racing.
 *  Guarding on `parser` alone only closed the window *after* both awaits below
 *  had resolved: two concurrent calls would each run `Parser.init` and
 *  `Language.load`, re-initialising the Emscripten module and orphaning a
 *  Parser and a Language in the WASM heap with nothing left to `.delete()`
 *  them. One caller today, but it is the only unguarded allocation here. */
let initializing: Promise<void> | undefined;

export async function initParser(paths: ParserWasmPaths): Promise<void> {
  if (parser) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await Parser.init({ locateFile: () => paths.runtimeWasm });
    language = await Language.load(paths.grammarWasm);
    const created = new Parser();
    created.setLanguage(language);
    parser = created;
  })();
  try {
    await initializing;
  } finally {
    // cleared either way: a failed init must not pin the rejection and make
    // every later attempt fail without retrying
    initializing = undefined;
  }
}

function span(node: Node): Span {
  return {
    start: { row: node.startPosition.row, column: node.startPosition.column },
    end: { row: node.endPosition.row, column: node.endPosition.column },
  };
}

function toAttr(node: Node): TfAttr | undefined {
  const name = node.namedChild(0);
  const value = node.namedChildren.find((c) => c !== null && c.type === 'expression');
  if (!name || !value) return undefined;
  // tree-sitter ends an unparseable attribute at the last token it understood
  // and opens a new one on the leftovers: `port = 1e3` becomes `port = 1` plus
  // a phantom `e3`. Both halves have to go.
  //
  // Only the phantom carries the error, so the gap to the next attribute is
  // what marks the fragment. HCL separates entries with a newline, so a
  // sibling starting at this one's last byte is a chopped tail — unless it's
  // a comment, where `a = 1# note` is complete and valid.
  if (node.hasError) return undefined;
  const next = node.nextSibling;
  if (next && next.startIndex === node.endIndex && next.type !== 'comment') return undefined;
  return { name: name.text, span: span(node), valueSpan: span(value), valueText: value.text };
}

/** required_providers entries like `aws = { source = "...", version = "..." }`
 *  become synthetic blocks kind:"provider_requirement", labels:[entry name].
 *  The legacy string form `aws = ">= 5.0"` becomes the same block with only a
 *  version attribute (Terraform implies source hashicorp/<name>). */
function providerRequirements(attr: Node): TfBlock | undefined {
  const name = attr.namedChild(0);
  const value = attr.namedChildren.find((c) => c !== null && c.type === 'expression');
  if (!name || !value) return undefined;
  const object = firstDescendant(value, 'object');
  if (!object) {
    const str = firstDescendant(value, 'string_lit') ?? firstDescendant(value, 'quoted_template');
    if (!str) return undefined;
    return {
      kind: 'provider_requirement',
      labels: [name.text],
      span: span(attr),
      bodySpan: span(str),
      attrs: [{ name: 'version', span: span(attr), valueSpan: span(str), valueText: str.text }],
      blocks: [],
    };
  }
  const attrs: TfAttr[] = [];
  for (const elem of object.namedChildren) {
    if (elem?.type !== 'object_elem') continue;
    const [key, val] = elem.namedChildren.filter((c) => c !== null && c.type === 'expression');
    if (!key || !val) continue;
    attrs.push({
      name: stripQuotes(key.text),
      span: span(elem),
      valueSpan: span(val),
      valueText: val.text,
    });
  }
  return {
    kind: 'provider_requirement',
    labels: [name.text],
    span: span(attr),
    bodySpan: span(object),
    attrs,
    blocks: [],
  };
}

function firstDescendant(node: Node, type: string): Node | undefined {
  if (node.type === type) return node;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const found = firstDescendant(c, type);
    if (found) return found;
  }
  return undefined;
}

function toBlock(node: Node): TfBlock | undefined {
  const kindNode = node.namedChild(0);
  if (kindNode?.type !== 'identifier') return undefined;
  const kind = kindNode.text;
  const labels: string[] = [];
  for (const c of node.namedChildren) {
    if (c && c.type === 'string_lit') labels.push(stripQuotes(c.text));
  }
  const body = node.namedChildren.find((c) => c !== null && c.type === 'body');
  const attrs: TfAttr[] = [];
  const blocks: TfBlock[] = [];
  if (body) {
    for (const c of body.namedChildren) {
      if (!c) continue;
      if (c.type === 'attribute') {
        const attr = toAttr(c);
        if (attr) attrs.push(attr);
        if (kind === 'required_providers') {
          const req = providerRequirements(c);
          if (req) blocks.push(req);
        }
      } else if (c.type === 'block') {
        const b = toBlock(c);
        if (b) blocks.push(b);
      }
    }
  }
  return {
    kind,
    labels,
    span: span(node),
    bodySpan: body ? span(body) : span(node),
    attrs,
    blocks,
  };
}

/** Collect `variable_expr (get_attr)*` chains as references. Bare identifiers
 *  (object keys, attr names) are excluded — fewer than 2 parts. */
function collectRefs(node: Node, refs: TfRef[]): void {
  // Hoisted once per node. `namedChild(i)` marshals a node across the wasm
  // boundary and is O(log n) by the library's own documentation, and this loop
  // called it ~2k+1 times per node with k children — plus a second time for the
  // same index on every reference — where `namedChildren` crosses once and
  // memoises the array. This runs over every named node of every file, at
  // startup and again on every debounced keystroke.
  const children = node.namedChildren;
  let i = 0;
  while (i < children.length) {
    const c = children[i];
    if (!c) {
      i++;
      continue;
    }
    if (c.type === 'variable_expr') {
      const parts = [c.text];
      let end = c.endPosition;
      let j = i + 1;
      // a comment is a node of its own between the subject and the dot, and
      // stopping on it truncates the reference — `local /*c*/ .x` collected
      // nothing and the unused-locals lint then offered to delete a local that
      // is used, the expensive direction to be wrong in
      while (children[j]?.type === 'comment') j++;
      let next = children[j];
      while (next?.type === 'get_attr') {
        // whitespace and comments are both legal around the dot — `local. name`
        // and `local. /*c*/ x` are each one clean get_attr, and a part that
        // keeps the padding matches no local
        parts.push(stripComments(next.text.replace(/^\s*\.\s*/, '')).trim());
        end = next.endPosition;
        j++;
        while (children[j]?.type === 'comment') j++;
        next = children[j];
      }
      if (parts.length >= 2) {
        refs.push({
          parts,
          span: {
            start: { row: c.startPosition.row, column: c.startPosition.column },
            end: { row: end.row, column: end.column },
          },
        });
      }
      i = j;
    } else {
      collectRefs(c, refs);
      i++;
    }
  }
}

/** Parse a lone expression ("${var.env}-app", length(var.x), …) and hand its
 *  CST node to `use`. Frees the tree afterward; undefined on parse failure. */
export function withExpressionNode<T>(text: string, use: (expr: Node) => T): T | undefined {
  if (!parser) throw new Error('initParser() must be called before withExpressionNode()');
  const source = `x = ${text}`;
  const tree = parser.parse(source);
  if (!tree) return undefined;
  try {
    const body = tree.rootNode.namedChildren.find((c) => c !== null && c.type === 'body');
    const attr = body?.namedChildren.find((c) => c !== null && c.type === 'attribute');
    const expr = attr?.namedChildren.find((c) => c !== null && c.type === 'expression');
    if (!expr) return undefined;
    // the grammar dumps what it can't parse into an ERROR sibling this walk
    // ignores, so a partial parse (`1e3` → `1`, `e3` discarded) would otherwise
    // reach the evaluator as a whole one. Leftover text means the parse
    // failed, and ⟨unknown⟩ is the honest answer
    if (source.slice(expr.endIndex).trim() !== '') return undefined;
    return use(expr);
  } finally {
    tree.delete();
  }
}

export function parseFile(path: string, source: string): ParsedFile {
  if (!parser) throw new Error('initParser() must be called before parseFile()');
  const tree = parser.parse(source);
  const blocks: TfBlock[] = [];
  const refs: TfRef[] = [];
  // Whether tree-sitter had to recover. `collectRefs` can only report what it
  // managed to parse, so a file mid-edit yields *fewer* refs than the text
  // really contains — and "no references" is exactly what unlocks the
  // destructive count→for_each rewrite. Recorded so a caller can tell "nothing
  // references this" from "I could not read what references this".
  let hasError = true;
  if (tree) {
    // same finally as withExpressionNode: the walks below are the only thing
    // between allocation and delete, and a throw there would strand the tree
    // in wasm memory for the life of the extension host
    try {
      const bodyNode = tree.rootNode.namedChildren.find((c) => c !== null && c.type === 'body');
      if (bodyNode) {
        for (const c of bodyNode.namedChildren) {
          if (!c) continue;
          if (c.type === 'block') {
            const b = toBlock(c);
            if (b) blocks.push(b);
          } else if (c.type === 'attribute') {
            // top-level attribute (tfvars files)
            const attr = toAttr(c);
            if (attr) {
              blocks.push({
                kind: 'tfvars_entry',
                labels: [attr.name],
                span: attr.span,
                bodySpan: attr.valueSpan,
                attrs: [attr],
                blocks: [],
              });
            }
          }
        }
      }
      collectRefs(tree.rootNode, refs);
      hasError = tree.rootNode.hasError;
    } finally {
      tree.delete();
    }
  }
  // Only the file currently being linted or hovered ever reads `lines`, and it
  // reads one or two of them. Splitting eagerly kept one string per line of
  // every indexed file alive for the whole session — on a 2000-file workspace
  // that is ~160k live strings for data derivable in microseconds — and paid
  // for it again on every debounced keystroke.
  let lines: string[] | undefined;
  return {
    path,
    source,
    blocks,
    refs,
    hasError,
    get lines(): string[] {
      lines ??= source.split(/\r?\n/);
      return lines;
    },
  };
}
