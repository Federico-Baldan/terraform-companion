import type { Node } from 'web-tree-sitter';
import { attrOf } from './hcl';
import { withExpressionNode } from './parser';
import type { ModuleCallSite, WorkspaceIndex } from './workspaceIndex';

export const UNKNOWN = '⟨unknown⟩';
const MAX_DEPTH = 10;

export interface EvalUsage {
  /** var names whose value came from a tfvars file (root module only) */
  tfvars: Set<string>;
  tfvarsFiles: Set<string>;
  /** var name → file whose variable block supplied the default */
  defaults: Map<string, string>;
  /** call sites traversed to carry a value into a submodule, root → leaf */
  calls: Set<string>;
  /** call-site label → value, when module instances pass different values */
  conflicts: Map<string, string>;
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

export interface EvalScope {
  index: WorkspaceIndex;
  moduleDir: string;
  /** Per-directory lookup, not one map — climbing from submodule to caller
   *  needs the caller's own tfvars. */
  tfvarsOf?: (moduleDir: string) => Map<string, TfvarsValue>;
  /** module dir → the single call site to resolve through, ignoring the others */
  pinnedSites?: Map<string, ModuleCallSite>;
  used?: EvalUsage;
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

function render(v: Value): string {
  if (v === undefined) return UNKNOWN;
  if (Array.isArray(v)) return `[${v.map(render).join(', ')}]`;
  if (isObject(v)) {
    return `{${[...v].map(([k, val]) => `${k} = ${render(val)}`).join(', ')}}`;
  }
  return v instanceof NonString ? v.text : v;
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
const FORMAT_VERB = /%(%|(?:([-+ #0]*)(\d+)?(?:\.(\d+))?(?:\[(\d+)\])?([a-zA-Z])))/g;

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
  }
  const tail = template.slice(cursor);
  if (tail.includes('%')) return undefined;
  return out + tail;
}

function callFunction(name: string, args: Value[]): Value {
  switch (name) {
    case 'join': {
      const [sep, list] = args;
      const delim = asString(sep);
      if (delim === undefined || !Array.isArray(list)) return undefined;
      const items = list.map(asString);
      return items.every((i) => i !== undefined) ? items.join(delim) : undefined;
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
      return (args as Value[][]).flat();
    }
    case 'toset': {
      const list = args[0];
      if (!Array.isArray(list)) return undefined;
      // sets dedupe and sort lexically, but only for known strings — anything
      // else keeps its elements for shape checks
      return list.every((v): v is string => typeof v === 'string')
        ? [...new Set(list)].sort()
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
          parts.push(child.text.replace(/^\s*\./, ''));
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
      }
      return out;
    }
    case 'tuple':
      return named(node)
        .filter((c) => c.type === 'expression')
        .map((c) => evalNode(c, scope, depth));
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
      return out;
    }
    case 'function_call': {
      const name = named(node).find((c) => c.type === 'identifier')?.text ?? '';
      const argsNode = named(node).find((c) => c.type === 'function_arguments');
      const args = argsNode
        ? named(argsNode)
            .filter((c) => c.type === 'expression')
            .map((c) => evalNode(c, scope, depth))
        : [];
      return callFunction(name, args);
    }
    default:
      return undefined;
  }
}

/** `var.x` / `local.x`, plus an attribute path into whatever they resolve to. */
function resolveRefValue(parts: string[], scope: EvalScope, depth: number): Value {
  if (depth > MAX_DEPTH) return undefined;
  const [head, name] = parts;
  if (!name) return undefined;
  const path = parts.slice(2);
  if (head === 'var') return walkPath(resolveVar(name, scope, depth), path);
  if (head === 'local') {
    const def = scope.index.localsOf(scope.moduleDir).find((l) => l.name === name);
    return def ? walkPath(evalText(def.attr.valueText, scope, depth), path) : undefined;
  }
  return undefined;
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
  return labelsAt(maxSegments);
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
    const passed = entries.map(({ site, attr, label }) => {
      const callerScope: EvalScope = { ...scope, moduleDir: site.callerDir };
      return {
        label,
        // an instance that omits the var falls back to the module's own default
        value: attr
          ? evalText(attr.valueText, callerScope, depth + 1)
          : varDefault(name, scope, depth),
      };
    });
    const rendered = passed.map((p) => render(p.value));
    if (rendered.every((r) => r === rendered[0])) {
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

export function resolveExpr(text: string, scope: EvalScope): string {
  return render(evalText(text, scope, 0));
}

export function resolveRef(parts: string[], scope: EvalScope): string {
  return render(resolveRefValue(parts, scope, 0));
}

/** What an expression looks like to `for_each`. Callers get values, not a
 *  rendered string, so the internal Value type stays private. */
export type ListShape =
  | { kind: 'strings'; values: string[] }
  | { kind: 'nonStrings' }
  | { kind: 'unknown' };

export function listShape(text: string, scope: EvalScope): ListShape {
  const value = evalText(text, scope, 0);
  if (!Array.isArray(value)) return { kind: 'unknown' };
  // an unresolved element says nothing; a resolved non-string says everything
  // — numbers count too, for_each rejects those
  if (value.some((v) => Array.isArray(v) || isObject(v) || v instanceof NonString)) {
    return { kind: 'nonStrings' };
  }
  return value.every((v) => typeof v === 'string')
    ? { kind: 'strings', values: value }
    : { kind: 'unknown' };
}
