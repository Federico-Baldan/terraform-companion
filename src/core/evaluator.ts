import type { Node } from 'web-tree-sitter';
import { attrOf } from './hcl';
import { withExpressionNode } from './parser';
import type { ModuleCallSite, WorkspaceIndex } from './workspaceIndex';

export const UNKNOWN = '⟨unknown⟩';
const MAX_DEPTH = 10;

/** A hover shows a value, and nothing here needs to build one bigger than a
 *  reader could ever be shown. Interpolation multiplies rather than adds —
 *  `name = "${local.a}${local.a}"` doubles the value at every level — so a
 *  dozen lines of HCL can expand into tens of megabytes that the renderer then
 *  throws away. Capping the string keeps a pathological (or half-typed) file
 *  from doing that work on the extension host. */
const MAX_VALUE_CHARS = 100_000;

export interface EvalUsage {
  /** var names whose value came from a tfvars file (root module only) */
  tfvars: Set<string>;
  tfvarsFiles: Set<string>;
  /** var name → file whose variable block supplied the default */
  defaults: Map<string, string>;
  /** call sites traversed to carry a value into a submodule, root → leaf */
  calls: Set<string>;
  /** call-site label → value, when module instances pass different values.
   *  Carries the shape because each row is rendered on its own terms — one
   *  instance can pass a name and another a list. */
  conflicts: Map<string, ResolvedValue>;
  /** Where call sites disagreed — `"app-${var.env}"` needs per-instance eval,
   *  so this marks where to branch. */
  divergedAt?: { moduleDir: string; sites: ModuleCallSite[]; labels: string[] };
}

export function emptyUsage(): EvalUsage {
  return {
    tfvars: new Set(),
    tfvarsFiles: new Set(),
    defaults: new Map(),
    calls: new Set(),
    conflicts: new Map(),
  };
}

export interface TfvarsValue {
  /** raw HCL value text, e.g. `"eu-west-1"` */
  text: string;
  file: string;
}

/** Shared for the length of one top-level resolve. `resolveRefValue` re-parses
 *  a local's text on every hop, and a reference reached N ways used to be
 *  evaluated N times, so cost was fan-out to the power of the chain length —
 *  measurably tens of seconds of frozen extension host for thirteen lines of
 *  HCL. Memoising makes it once per (module, reference).
 *
 *  `inProgress` is what stops a cycle. It replaces the depth counter for
 *  references, which is why the memo can be depth-independent: a cached value
 *  no longer depends on how deep the first path to it happened to be. */
interface EvalState {
  cache: Map<string, Value>;
  inProgress: Set<string>;
  /** shared element budget for one resolve — see MAX_VALUE_ELEMENTS */
  elements: { left: number };
  /** How many times a budget gave up during this resolve.
   *
   *  "Too big to evaluate" and "cannot be evaluated" both come back as
   *  `undefined`, but they warrant opposite answers: a caller deciding whether
   *  a destructive refactor is safe reads an unreachable value as "nothing to
   *  object to", and must read an unmeasured one as "cannot certify". Counted
   *  rather than a flag so a caller can tell whether a *particular* subtree
   *  gave up, not merely whether anything did. */
  spends: number;
}

/** Elements one resolve may materialise.
 *
 *  The memo makes a value a DAG — `a = [local.b, local.b]` holds one array
 *  twice — which is what lets the renderer's char budget bound the work. But
 *  `concat` *copies*: its result is a new array as long as the sum of its
 *  inputs, so `a26 = concat(local.a25, local.a25)` really is 2^26 elements.
 *  Twenty-six of those lines measured 7.4s of frozen extension host and 2.6GB
 *  of heap, to render the same 100k characters the budget already caps — and
 *  two lines further it threw `RangeError: Invalid array length`. */
const MAX_VALUE_ELEMENTS = 100_000;

/** Charges the shared element budget. False once it is spent, which callers
 *  turn into ⟨unknown⟩ — the same answer MAX_VALUE_CHARS already gives. */
function chargeElements(scope: EvalScope, n: number): boolean {
  const state = scope.state;
  if (!state) return n <= MAX_VALUE_ELEMENTS;
  if (n > state.elements.left) {
    // deliberately does NOT zero the remaining budget: draining it here made
    // one oversized value poison every later sibling in the same resolve, so an
    // adjacent list that was perfectly measurable came back ⟨unknown⟩ too
    state.spends++;
    return false;
  }
  state.elements.left -= n;
  return true;
}

/** Reference hops one resolve may take. `inProgress` already stops a cycle, but
 *  it only bounds an honest chain at "distinct references in the module", and
 *  each hop costs four real JS frames — a generated `c0 = local.c1 … c1999 =
 *  local.c2000` ladder overflowed the stack, and the RangeError escaped
 *  `provideHover` and took the hover down entirely. Far past any real chain. */
const MAX_REF_HOPS = 256;

export interface EvalScope {
  index: WorkspaceIndex;
  moduleDir: string;
  /** Per-directory lookup, not one map — climbing from submodule to caller
   *  needs the caller's own tfvars. */
  tfvarsOf?: (moduleDir: string) => ReadonlyMap<string, TfvarsValue>;
  /** module dir → the single call site to resolve through, ignoring the others */
  pinnedSites?: Map<string, ModuleCallSite>;
  used?: EvalUsage;
  /** internal; the entry points install it, spreads carry it down */
  state?: EvalState;
}

/** Separate from strings because rendering loses the type: 8080 and "8080"
 *  look the same rendered, but for_each rejects numbers. */
class NonString {
  constructor(readonly text: string) {}
}

type Value = string | NonString | Value[] | ObjValue | undefined;
/** insertion-ordered so a rendered object reads in the order it was written */
type ObjValue = Map<string, Value>;

function isObject(v: Value): v is ObjValue {
  return v instanceof Map;
}

/** Terraform coerces numbers/bools to strings on demand, so drop the NonString
 *  tag here instead of returning ⟨unknown⟩. */
function asString(v: Value): string | undefined {
  if (typeof v === 'string') return v;
  if (v instanceof NonString) return v.text;
  return undefined;
}

/** tree-sitter leaves escapes verbatim in template_literal text; malformed
 *  ones stay as-is since Terraform would reject the file anyway. */
function unescapeTemplateLiteral(text: string): string {
  return text.replace(
    /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([nrt"\\]))|\$\$\{|%%\{/g,
    (whole, u4?: string, u8?: string, simple?: string) => {
      if (whole === '$${') return '${';
      if (whole === '%%{') return '%{';
      const hex = u4 ?? u8;
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      const simpleMap: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
      return simpleMap[simple ?? ''] ?? whole;
    },
  );
}

/** cty renders the parsed number, not the spelling: `1.50` → "1.5", `007` →
 *  "7". Scientific notation needs real numeric eval, so it's ⟨unknown⟩. */
function canonicalNumber(text: string): NonString | undefined {
  const m = text.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m?.[1]) return undefined;
  const int = m[1].replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return new NonString(frac === '' ? int : `${int}.${frac}`);
}

/** Appended when a render stopped early, so a truncated value can never be
 *  mistaken for a complete one. */
const TRUNCATED = '…';
/** The budget bounds how much is *emitted*, but a long reference chain
 *  (`a1 = [local.a0]`, a thousand times over) is deep before it is wide, and
 *  that depth is stack frames. Far past any real Terraform value. */
const MAX_RENDER_DEPTH = 64;

/** The one budgeted walk behind both renderers.
 *
 *  `EvalState`'s memo hands back the *same* array or Map on every cache hit, so
 *  `a = [local.b, local.b]` holds one array twice rather than two copies. That
 *  makes a value a DAG, and a renderer that expands a DAG as a tree doubles its
 *  work per level: twenty-two such levels measured 41,943,036 characters in
 *  1.6s of blocked extension host, from twenty-five lines of HCL.
 *
 *  MAX_VALUE_CHARS already stated the intent, but it only ever guarded the
 *  string-interpolation path, and it guarded the *result* — the megabytes were
 *  built before anything measured them. Charging the budget as the walk emits
 *  is what bounds the work instead of just the answer. */
function renderInto(
  v: Value,
  out: string[],
  budget: { left: number },
  depth: number,
  tagged: boolean,
): void {
  if (budget.left <= 0) return;
  const emit = (s: string): void => {
    // Clip the leaf rather than only charging for it. `format` and `join` build
    // a single string that can be megabytes on its own, and pushing it whole
    // made the budget a *reporter* of the overrun — render() appended its `…`
    // to the 10MB it had already emitted. The full length is still charged, so
    // the truncation marker is appended exactly as before, and the first
    // MAX_VALUE_CHARS are preserved, which renderTagged's divergence comparison
    // depends on.
    out.push(s.length > budget.left ? s.slice(0, Math.max(budget.left, 0)) : s);
    budget.left -= s.length;
  };
  // '\0' is renderTagged's type separator: it cannot occur in HCL text, so a
  // tag can never collide with a value that merely looks like one
  if (depth > MAX_RENDER_DEPTH || v === undefined) {
    emit(tagged ? '\0unknown' : UNKNOWN);
    return;
  }
  if (Array.isArray(v)) {
    emit('[');
    for (const [i, item] of v.entries()) {
      if (budget.left <= 0) break;
      if (i > 0) emit(', ');
      renderInto(item, out, budget, depth + 1, tagged);
    }
    emit(']');
    return;
  }
  if (isObject(v)) {
    emit('{');
    let first = true;
    for (const [k, val] of v) {
      if (budget.left <= 0) break;
      if (!first) emit(', ');
      first = false;
      emit(`${k} = `);
      renderInto(val, out, budget, depth + 1, tagged);
    }
    emit('}');
    return;
  }
  if (v instanceof NonString) {
    emit(tagged ? `\0n:${v.text}` : v.text);
    return;
  }
  emit(tagged ? `\0s:${v}` : v);
}

function renderBudgeted(v: Value, tagged: boolean): string {
  const out: string[] = [];
  const budget = { left: MAX_VALUE_CHARS };
  renderInto(v, out, budget, 0, tagged);
  const text = out.join('');
  if (budget.left > 0) return text;
  // The overflow is the exact number of characters charged past the cap. A
  // tagged render needs it: `emit` now clips, so two values sharing a
  // MAX_VALUE_CHARS prefix but differing in length produce identical text, and
  // the divergence check would call two genuinely different instance values
  // equal — then show one instance's value as if every instance agreed.
  return tagged ? `${text}${TRUNCATED}\0#${MAX_VALUE_CHARS - budget.left}` : `${text}${TRUNCATED}`;
}

function render(v: Value): string {
  return renderBudgeted(v, false);
}

/** `null` as written in HCL. Terraform reads an explicit null module input as
 *  "not set", which is how a caller opts back into the module's default. */
function isNull(v: Value): boolean {
  return v instanceof NonString && v.text === 'null';
}

/** `render` for comparison rather than display: it keeps the string/non-string
 *  distinction that rendering throws away, so "8080" and 8080 do not compare
 *  equal. Never shown to anyone. */
/** Truncates rather than collapsing to a single marker on purpose: two
 *  distinct over-budget values still differ somewhere inside their first
 *  MAX_VALUE_CHARS, so the divergence check keeps working. One shared
 *  "too big" token would make every huge value compare equal to every
 *  other, and silently agreeing call sites is the wrong way to be wrong. */
function renderTagged(v: Value): string {
  return renderBudgeted(v, true);
}

/** A path that runs into a string, a list or a missing key is unknown, not wrong. */
function walkPath(value: Value, path: string[]): Value {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current.get(key);
  }
  return current;
}

function named(n: Node): Node[] {
  return n.namedChildren.filter((c): c is Node => c !== null);
}

/** go-cty's format verb: `%` [flags] [width] [.precision] [`[n]`] verb.
 *  `%%` is matched separately as the escape. */
/** The width is `[1-9]\d*`, not `\d*`: `[-+ #0]*` and `\d+` both match `0`, so
 *  a `%` followed by a long run of zeros and no verb letter made the engine try
 *  every flags/width split — 40k zeros measured 2.7s, per hover. A width never
 *  starts with `0` in go-cty's grammar (that spelling is the zero-pad flag), so
 *  removing the overlap costs nothing: `%08d` still reads flags `0`, width `8`. */
const FORMAT_VERB = /%(%|(?:([-+ #0]*)([1-9]\d*)?(?:\.(\d+))?(?:\[(\d+)\])?([a-zA-Z])))/g;

/** Verbs reproducible byte for byte from an already-resolved value's text. */
const PLAIN_VERBS = new Set(['s', 'v', 'd', 'q']);

/** Terraform's `format`: matches go-cty exactly or bails. go-cty errors on
 *  unknown verbs, so passing one through would be wrong. */
function formatString(template: string, args: Value[]): string | undefined {
  let out = '';
  let cursor = 0;
  // explicit [n] also moves the implicit counter (Go behavior): "%[2]s %s"
  // reads arg 2 then arg 3
  let next = 0;
  FORMAT_VERB.lastIndex = 0;
  for (let m = FORMAT_VERB.exec(template); m !== null; m = FORMAT_VERB.exec(template)) {
    // a stray % that starts no valid directive is a go-cty error, not a literal
    if (template.slice(cursor, m.index).includes('%')) return undefined;
    out += template.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    if (m[1] === '%') {
      out += '%';
      continue;
    }
    const [, , flags, width, precision, argIndex, verb] = m;
    if (flags || width !== undefined || precision !== undefined) return undefined;
    if (!verb || !PLAIN_VERBS.has(verb)) return undefined;
    const at = argIndex === undefined ? next : Number(argIndex) - 1;
    if (at < 0 || at >= args.length) return undefined;
    next = at + 1;
    const arg = args[at];
    const text = asString(arg);
    if (text === undefined) return undefined;
    // %v uses big.Float's %g, which goes scientific outside [0.0001, 1e6):
    // format("%v", 1000000) is "1e+06"
    if (verb === 'v' && arg instanceof NonString) {
      const num = text.match(/^(\d+)(?:\.(\d+))?$/);
      if (num?.[1] && (num[1] === '0' ? /^0{4}/.test(num[2] ?? '') : num[1].length > 6)) {
        return undefined;
      }
    }
    // %d errors unless the argument is a whole number
    if (verb === 'd' && !/^-?\d+$/.test(text)) return undefined;
    out += verb === 'q' ? JSON.stringify(text) : text;
    // Same bail the interpolation path takes, and for the same reason: format
    // multiplies rather than adds, so `f24 = format("%s%s", local.f23,
    // local.f23)` is 25 lines of HCL and 167M characters. Unbounded, the string
    // was built in full and then flattened three more times by the hover
    // renderer — 27 lines measured 3.6s and 1.2GB.
    if (out.length > MAX_VALUE_CHARS) return undefined;
  }
  const tail = template.slice(cursor);
  if (tail.includes('%')) return undefined;
  return out.length + tail.length > MAX_VALUE_CHARS ? undefined : out + tail;
}

/** Lexicographic by code point, which is the order UTF-8 bytes sort in — what
 *  cty uses for set elements. */
function compareCodePoints(a: string, b: string): number {
  const ax = [...a];
  const bx = [...b];
  for (let i = 0; i < ax.length && i < bx.length; i++) {
    const d = (ax[i]?.codePointAt(0) ?? 0) - (bx[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return ax.length - bx.length;
}

function callFunction(name: string, args: Value[], scope: EvalScope): Value {
  switch (name) {
    case 'join': {
      const [sep, list] = args;
      const delim = asString(sep);
      if (delim === undefined || !Array.isArray(list)) return undefined;
      const items = list.map(asString);
      if (!items.every((i) => i !== undefined)) return undefined;
      // measured before joining: `join("", local.b20)` over a concat-doubled
      // list produced 10MB from 25 lines of HCL, and the renderer's budget
      // cannot undo a string that already exists
      let total = delim.length * Math.max(items.length - 1, 0);
      for (const s of items) total += s.length;
      if (total <= MAX_VALUE_CHARS) return items.join(delim);
      if (scope.state) scope.state.spends++;
      return undefined;
    }
    case 'format': {
      const [fmt, ...rest] = args;
      const template = asString(fmt);
      return template === undefined ? undefined : formatString(template, rest);
    }
    case 'lower':
      return asString(args[0])?.toLowerCase();
    case 'upper':
      return asString(args[0])?.toUpperCase();
    case 'concat': {
      if (!args.every(Array.isArray)) return undefined;
      const lists = args as Value[][];
      let total = 0;
      for (const l of lists) total += l.length;
      // flat() allocates a genuinely new array, so this is the one place a value
      // stops being a DAG and starts doubling for real
      return chargeElements(scope, total) ? lists.flat() : undefined;
    }
    case 'toset': {
      const list = args[0];
      if (!Array.isArray(list)) return undefined;
      // sets dedupe and sort lexically, but only for known strings — anything
      // else keeps its elements for shape checks
      // cty orders a set by the element's bytes; JS's default sort compares
      // UTF-16 code units, which disagree once an astral character meets one in
      // U+E000–U+FFFF. Code-point order is UTF-8 byte order.
      return list.every((v): v is string => typeof v === 'string')
        ? [...new Set(list)].sort(compareCodePoints)
        : list;
    }
    default:
      return undefined;
  }
}

function evalNode(node: Node, scope: EvalScope, depth: number): Value {
  if (depth > MAX_DEPTH) return undefined;
  switch (node.type) {
    case 'expression': {
      const children = named(node);
      const first = children[0];
      if (first?.type === 'variable_expr') {
        const parts = [first.text];
        for (let i = 1; i < children.length; i++) {
          const child = children[i];
          if (child?.type !== 'get_attr') return undefined; // index/splat: give up
          // whitespace is legal on both sides of the dot (see parser.ts)
          parts.push(child.text.replace(/^\s*\.\s*/, ''));
        }
        return resolveRefValue(parts, scope, depth + 1);
      }
      return children.length === 1 && first ? evalNode(first, scope, depth) : undefined;
    }
    case 'literal_value':
    case 'template_expr':
    case 'collection_value': {
      const children = named(node);
      const sole = children.length === 1 ? children[0] : undefined;
      return sole ? evalNode(sole, scope, depth) : undefined;
    }
    case 'numeric_lit':
      return canonicalNumber(node.text);
    case 'bool_lit':
      return new NonString(node.text);
    case 'null_lit':
      return new NonString('null');
    case 'string_lit':
    case 'quoted_template': {
      // whitespace is a grammar "extra", so it belongs to no named node — the
      // gaps between children have to come from raw text, rebased to this
      // node's start
      const raw = node.text;
      const base = node.startIndex;
      const gap = (from: number, to: number) =>
        to > from ? raw.slice(from - base, to - base) : '';
      let out = '';
      let cursor = node.startIndex;
      for (const c of named(node)) {
        switch (c.type) {
          // quotes carry no text, but whitespace before the closing one does:
          // "trail  " keeps its padding
          case 'quoted_template_start':
            break;
          case 'quoted_template_end':
            out += unescapeTemplateLiteral(gap(cursor, c.startIndex));
            break;
          case 'template_literal':
            // decoded with the gap, so an escape cannot split across the seam
            out += unescapeTemplateLiteral(gap(cursor, c.startIndex) + c.text);
            break;
          case 'template_interpolation': {
            out += unescapeTemplateLiteral(gap(cursor, c.startIndex));
            const inner = named(c).find((x) => x.type === 'expression');
            out += inner ? render(evalNode(inner, scope, depth)) : UNKNOWN;
            break;
          }
          // %{ if }/%{ for } branch on a condition we never evaluate and
          // restructure the string instead of filling a slot — the whole
          // string is unknown, not partial
          default:
            return undefined;
        }
        cursor = c.endIndex;
        // bail on the way up, not at the end: each child is already capped, so
        // stopping here bounds this node too instead of letting the product
        // compound level by level
        if (out.length > MAX_VALUE_CHARS) return undefined;
      }
      return out;
    }
    case 'tuple': {
      // charged too, so a hand-written or generated 200k-element literal is
      // covered by the same budget as concat
      const items = named(node)
        .filter((c) => c.type === 'expression')
        .map((c) => evalNode(c, scope, depth));
      return chargeElements(scope, items.length) ? items : undefined;
    }
    case 'object': {
      const out: ObjValue = new Map();
      for (const elem of named(node)) {
        if (elem.type !== 'object_elem') continue;
        const [key, value] = named(elem).filter((c) => c.type === 'expression');
        if (!key || !value) continue;
        // a bare key is literal: { env = 1 } has key "env" even if var.env exists
        const name = /^[\w-]+$/.test(key.text.trim())
          ? key.text.trim()
          : asString(evalNode(key, scope, depth));
        if (name === undefined) continue;
        out.set(name, evalNode(value, scope, depth));
      }
      return chargeElements(scope, out.size) ? out : undefined;
    }
    case 'function_call': {
      const name = named(node).find((c) => c.type === 'identifier')?.text ?? '';
      const argsNode = named(node).find((c) => c.type === 'function_arguments');
      const args = argsNode
        ? named(argsNode)
            .filter((c) => c.type === 'expression')
            .map((c) => evalNode(c, scope, depth))
        : [];
      return callFunction(name, args, scope);
    }
    default:
      return undefined;
  }
}

/** `var.x` / `local.x`, plus an attribute path into whatever they resolve to. */
function resolveRefValue(parts: string[], scope: EvalScope, depth: number): Value {
  const [head, name] = parts;
  if (!name) return undefined;
  if (head !== 'var' && head !== 'local') return undefined;
  const path = parts.slice(2);
  // the reference itself, without the attribute path — `local.cfg.db.host` and
  // `local.cfg.name` resolve the same object and differ only in the walk
  const key = `${scope.moduleDir} ${head}.${name}`;
  const state = scope.state;
  if (state) {
    if (state.cache.has(key)) return walkPath(state.cache.get(key), path);
    // a reference that is already being resolved is a cycle, whatever its
    // shape: a local reading itself, or two modules calling each other
    if (state.inProgress.has(key)) return undefined;
    // inProgress is exactly the DFS ancestor set, so its size is the chain
    // depth — and depth here is JS stack frames, four per hop. See MAX_REF_HOPS.
    if (state.inProgress.size >= MAX_REF_HOPS) {
      state.spends++;
      return undefined;
    }
    state.inProgress.add(key);
  }
  const spendsBefore = state?.spends ?? 0;
  let value: Value;
  if (head === 'var') {
    value = resolveVar(name, scope, depth);
  } else {
    const def = scope.index.localsOf(scope.moduleDir).find((l) => l.name === name);
    // a definition starts its own expression, so structural depth restarts with
    // it; the chain is bounded by inProgress instead
    value = def ? evalText(def.attr.valueText, scope, 0) : undefined;
  }
  if (state) {
    state.inProgress.delete(key);
    // An `undefined` produced because *this* subtree ran out of budget is not
    // an answer about this reference, and caching it would hand the same
    // ⟨unknown⟩ to an unrelated lookup that would have resolved fine. Scoped to
    // this key's own evaluation, so the memo still stops the fan-out blowup it
    // exists for — only the chain that actually gave up goes uncached.
    if (value !== undefined || state.spends === spendsBefore) state.cache.set(key, value);
  }
  return walkPath(value, path);
}

/** Module name + shortest path suffix that disambiguates sites — basenames
 *  alone would collapse envs/dev/main.tf and envs/prod/main.tf into one. */
function siteLabels(sites: ModuleCallSite[]): string[] {
  const paths = sites.map((s) => s.file.replace(/\\/g, '/').split('/'));
  const maxSegments = Math.max(...paths.map((p) => p.length));
  const labelsAt = (depth: number) =>
    sites.map(
      (s, i) =>
        `module "${s.block.labels[0] ?? '?'}" (${(paths[i] ?? []).slice(-depth).join('/')})`,
    );
  for (let depth = 1; depth < maxSegments; depth++) {
    const labels = labelsAt(depth);
    if (new Set(labels).size === sites.length) return labels;
  }
  // two blocks with the same name in one file are invalid Terraform, but they
  // exist while you are pasting the second one. Callers key rows by label, so
  // leaving the collision drops an instance from a list whose whole job is to
  // say the instances disagree.
  const seen = new Map<string, number>();
  return labelsAt(maxSegments).map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} #${n}`;
  });
}

/** Terraform semantics: root-module vars come from tfvars then default;
 *  called-module vars come from the call site (evaluated in the caller's
 *  scope, up to the root) then default — never from tfvars. */
function resolveVar(name: string, scope: EvalScope, depth: number): Value {
  const pinned = scope.pinnedSites?.get(scope.moduleDir);
  // having call sites is what makes a dir a "called module" — no separate root
  // flag to drift out of sync and let stray tfvars outrank the call site
  const sites = pinned ? [pinned] : scope.index.externalCallSitesOf(scope.moduleDir);
  if (sites.length > 0) {
    const labels = siteLabels(sites);
    const entries = sites
      .map((site, i) => ({
        site,
        attr: attrOf(site.block, name),
        label: labels[i] ?? '?',
      }))
      // stable output regardless of the order files were discovered in
      .sort((a, b) => a.label.localeCompare(b.label));
    // no instance passes the var → every instance uses the default
    if (entries.every((e) => !e.attr)) return varDefault(name, scope, depth);
    const spendsAtEntry = scope.state?.spends ?? 0;
    const passed = entries.map(({ site, attr, label }) => {
      const callerScope: EvalScope = { ...scope, moduleDir: site.callerDir };
      const fromCall = attr ? evalText(attr.valueText, callerScope, depth + 1) : undefined;
      return {
        label,
        // an instance that omits the var falls back to the module's own
        // default, and so does one that passes `null`: Terraform treats an
        // explicit null input as "not set" precisely so a caller can opt back
        // into the default
        value: attr && !isNull(fromCall) ? fromCall : varDefault(name, scope, depth),
      };
    });
    // compared by a type-tagged spelling, not the rendered one: `["8080"]` and
    // `[8080]` render identically, and calling those instances "agreeing" hands
    // back one instance's type for all of them — enough for the count→for_each
    // refactor to be offered on a module that is passed numbers, which for_each
    // rejects
    const rendered = passed.map((p) => renderTagged(p.value));
    // Sites share one EvalState, so a budget spent while evaluating an earlier
    // site would make later ones give up too — and several ⟨unknown⟩s compare
    // equal, which reads as agreement. Falling through to the divergence branch
    // makes the caller re-resolve each site under its own fresh budget, which
    // is the only way to find out what they actually pass.
    const spentComparing = (scope.state?.spends ?? 0) > spendsAtEntry;
    if (!spentComparing && rendered.every((r) => r === rendered[0])) {
      // one site is a real chain hop; several agreeing sites are siblings —
      // group them instead of reading as a chain
      if (passed.length === 1 && passed[0]) scope.used?.calls.add(passed[0].label);
      else scope.used?.calls.add(passed.map((p) => p.label).join(', '));
      return passed[0]?.value;
    }
    // report where instances diverge, not per-site values — caller re-resolves
    // the whole expression once per site
    if (scope.used && !scope.used.divergedAt) {
      scope.used.divergedAt = {
        moduleDir: scope.moduleDir,
        sites: entries.map((e) => e.site),
        labels: entries.map((e) => e.label),
      };
    }
    return undefined;
  }
  // root module: the tfvars in force *here*, then the default
  const entry = scope.tfvarsOf?.(scope.moduleDir).get(name);
  if (entry !== undefined) {
    scope.used?.tfvars.add(name);
    scope.used?.tfvarsFiles.add(entry.file);
    return evalText(entry.text, scope, depth);
  }
  return varDefault(name, scope, depth);
}

function varDefault(name: string, scope: EvalScope, depth: number): Value {
  const variable = scope.index.variablesOf(scope.moduleDir).get(name);
  const def = variable && attrOf(variable.block, 'default');
  if (!variable || !def) return undefined;
  scope.used?.defaults.set(name, variable.file);
  return evalText(def.valueText, scope, depth);
}

function evalText(text: string, scope: EvalScope, depth: number): Value {
  return withExpressionNode(text, (expr) => evalNode(expr, scope, depth));
}

/** A fresh memo per top-level resolve, on a copy — the caller's scope is left
 *  alone so a re-resolve under different `pinnedSites` can't read values cached
 *  for a different call site. */
function withState(scope: EvalScope): EvalScope {
  return {
    ...scope,
    state: {
      cache: new Map(),
      inProgress: new Set(),
      elements: { left: MAX_VALUE_ELEMENTS },
      spends: 0,
    },
  };
}

export function resolveExpr(text: string, scope: EvalScope): string {
  return render(evalText(text, withState(scope), 0));
}

/** What kind of thing a value turned out to be. The rendered text cannot say:
 *  a string whose content is "[redacted]" renders exactly like a two-element
 *  list, so anything reasoning about the value rather than displaying it needs
 *  this alongside. */
export type ValueShape = 'scalar' | 'collection' | 'unknown';

export interface ResolvedValue {
  /** the rendered text, as `resolveRef` returns it */
  text: string;
  shape: ValueShape;
}

function shapeOf(v: Value): ValueShape {
  if (v === undefined) return 'unknown';
  // a number, bool or null is still one value with one spelling — only a list
  // or object is a rendering of several
  return Array.isArray(v) || isObject(v) ? 'collection' : 'scalar';
}

/** `resolveRef` with the shape the rendering throws away. */
export function resolveRefShaped(parts: string[], scope: EvalScope): ResolvedValue {
  const value = resolveRefValue(parts, withState(scope), 0);
  return { text: render(value), shape: shapeOf(value) };
}

export function resolveRef(parts: string[], scope: EvalScope): string {
  return resolveRefShaped(parts, scope).text;
}

/** What an expression looks like to `for_each`. Callers get values, not a
 *  rendered string, so the internal Value type stays private. */
export type ListShape =
  | { kind: 'strings'; values: string[] }
  | { kind: 'nonStrings' }
  /** `overBudget` separates "too big to evaluate" from "cannot be evaluated".
   *  Both come back as no value, but they deserve opposite answers: an
   *  unreachable list gives a caller nothing to object to, while an unmeasured
   *  one must never be certified safe for a destructive rewrite. */
  | { kind: 'unknown'; overBudget?: boolean };

export function listShape(text: string, scope: EvalScope): ListShape {
  const scoped = withState(scope);
  const value = evalText(text, scoped, 0);
  const unknown: ListShape =
    (scoped.state?.spends ?? 0) > 0 ? { kind: 'unknown', overBudget: true } : { kind: 'unknown' };
  if (!Array.isArray(value)) return unknown;
  // an unresolved element says nothing; a resolved non-string says everything
  // — numbers count too, for_each rejects those
  if (value.some((v) => Array.isArray(v) || isObject(v) || v instanceof NonString)) {
    return { kind: 'nonStrings' };
  }
  return value.every((v) => typeof v === 'string') ? { kind: 'strings', values: value } : unknown;
}
