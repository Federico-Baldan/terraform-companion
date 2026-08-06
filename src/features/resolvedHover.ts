import {
  type EvalScope,
  type EvalUsage,
  emptyUsage,
  resolveRefShaped,
  type TfvarsValue,
  UNKNOWN,
  type ValueShape,
} from '../core/evaluator';
import { spanContains } from '../core/hcl';
import type { ParsedFile, Pos } from '../core/model';
import { baseName } from '../core/paths';
import type { WorkspaceIndex } from '../core/workspaceIndex';

export interface DefinitionHit {
  kind: 'var' | 'local';
  name: string;
}

/** The var/local definition whose *name* sits under the cursor — an
 *  attribute name in a locals block, or a variable block's header line. */
export function definitionAt(file: ParsedFile, pos: Pos): DefinitionHit | undefined {
  for (const block of file.blocks) {
    if (block.kind === 'locals') {
      for (const attr of block.attrs) {
        const { row, column } = attr.span.start;
        if (pos.row === row && pos.column >= column && pos.column <= column + attr.name.length) {
          return { kind: 'local', name: attr.name };
        }
      }
    } else if (block.kind === 'variable' && block.labels[0]) {
      const name = block.labels[0];
      const row = block.span.start.row;
      if (pos.row === row) {
        // limit the hit to `variable "name"`, not the whole header line up to `{`
        const line = file.lines[row] ?? '';
        const q = line.indexOf(`"${name}"`);
        const end = q === -1 ? line.length : q + name.length + 2;
        if (pos.column >= block.span.start.column && pos.column <= end) {
          return { kind: 'var', name };
        }
      }
    }
  }
  return undefined;
}

/** var name → value from a parsed tfvars file, tagged with the file it came from. */
export function tfvarsValues(file: ParsedFile | undefined): Map<string, TfvarsValue> {
  const out = new Map<string, TfvarsValue>();
  if (!file) return out;
  for (const block of file.blocks) {
    if (block.kind === 'tfvars_entry' && block.labels[0] && block.attrs[0]) {
      out.set(block.labels[0], { text: block.attrs[0].valueText, file: file.path });
    }
  }
  return out;
}

/** Auto-loaded tfvars, lowest precedence first: terraform.tfvars, then
 *  *.auto.tfvars lexically. Only the root module's own dir is read.
 *  .tfvars.json is absent on purpose — the index parses HCL, not JSON. */
export function autoLoadedTfvars(index: WorkspaceIndex, moduleDir: string): string[] {
  const inDir = index
    .files()
    .map((f) => f.path)
    .filter((p) => p.endsWith('.tfvars') && index.moduleDirOf(p) === moduleDir);
  return [
    ...inDir.filter((p) => baseName(p) === 'terraform.tfvars'),
    ...inDir.filter((p) => p.endsWith('.auto.tfvars')).sort(),
  ];
}

/** Directory names that conventionally hold one tfvars per environment. These
 *  no longer gate discovery — a vars folder is recognised by what it holds, not
 *  by what it is called — but they still break ties, so `environments/` sorts
 *  above a folder that merely happens to have a tfvars in it. */
const VAR_DIR_NAMES = new Set([
  'env',
  'envs',
  'vars',
  'tfvars',
  'environments',
  'config',
  'params',
  'values',
  'live',
]);

/** How far below an ancestor a vars folder may sit. `environments/prod/` and
 *  `live/prod/vpc/` are the nesting people really use; past three levels we are
 *  crawling the repo rather than suggesting from its neighbourhood. */
const MAX_VARS_DEPTH = 3;

/** What one directory costs on the way down to a vars folder. A segment that
 *  names itself is the layout pointing at its own vars; anything else is a
 *  detour into somebody's subtree, and has to cost more than climbing a level
 *  would. Without that gap a sibling team's `env/` outranks the repo-wide
 *  `environments/` purely by sitting fewer directories from you, and in a
 *  monorepo enough siblings push the file you actually wanted off the list. */
const STEP_NAMED = 0.5;
const STEP_PLAIN = 1.5;

/** Enough to cover any real module's neighbourhood; past this the list stops
 *  being scannable and Browse is the better tool. */
const MAX_CANDIDATES = 20;

export interface TfvarsCandidate {
  path: string;
  /** files the module auto-loads sit in 'module'; everything reachable by a
   *  -var-file sits in 'nearby' */
  group: 'module' | 'nearby';
  /** path relative to the module dir — the label the picker shows */
  label: string;
}

function dirName(p: string): string {
  const n = p.replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  return i === -1 ? '.' : n.slice(0, i);
}

/** `dir` and every ancestor up to the workspace root containing it, nearest
 *  first. A dir under no known root yields only itself, so an out-of-workspace
 *  module can't walk up to the filesystem root.
 *
 *  Roots are allowed to nest — VS Code lets a multi-root workspace hold both
 *  `/repo` and `/repo/teams/pay` — so the widest containing one wins rather
 *  than the first listed, whose order is the user's and says nothing. A folder
 *  the user has open is one they can be offered files from; anchoring on the
 *  inner one would hide the `environments/` they share. */
function ancestorsWithin(dir: string, roots: string[]): string[] {
  const root = roots
    // a workspace folder that is a filesystem or drive root arrives as `/` or
    // `c:/`, and its trailing slash must not make the prefix test fail
    .map((r) => (r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r))
    .filter((r) => dir === r || dir.startsWith(`${r}/`))
    .sort((a, b) => a.length - b.length)[0];
  if (root === undefined) return [dir];
  const out: string[] = [];
  let cur = dir;
  for (;;) {
    out.push(cur);
    if (cur === root || cur.length <= root.length) break;
    cur = dirName(cur);
    if (cur === '.') break;
  }
  return out;
}

/** Path of `target` as written from `fromDir`, e.g. "../environments/prod.tfvars".
 *  Basenames collide constantly across environments; this doesn't. */
export function relativeTo(fromDir: string, target: string): string {
  const from = fromDir.replace(/\\/g, '/').split('/');
  const to = target.replace(/\\/g, '/').split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  const rest = to.slice(i);
  return up === 0 ? rest.join('/') : [...new Array(up).fill('..'), ...rest].join('/');
}

/** tfvars a module could plausibly be driven by, nearest first: its own dir,
 *  then ancestors and any vars folder in their neighbourhood. The list is a
 *  suggestion, not an index — Browse reaches anything it misses — so it errs
 *  towards offering a file you won't click over hiding one you'd have to go
 *  find by hand. What it will not do is enumerate the repo: a directory
 *  carrying `.tf` files is somebody's module and its tfvars belong to it. */
export function tfvarsCandidates(
  index: WorkspaceIndex,
  moduleDir: string,
  roots: string[],
): { candidates: TfvarsCandidate[]; truncated: boolean } {
  const ancestors = ancestorsWithin(moduleDir, roots);
  const rank = new Map(ancestors.map((dir, i) => [dir, i]));
  // Terraform auto-loads a module's tfvars in the module's own directory, so a
  // directory holding `.tf` is answering for itself and is not a vars folder.
  // Everything else that holds tfvars is one, whatever it is called —
  // `environments/prod/`, `live/prod/vpc/`, `config/`, or a name only this
  // company uses. Naming the folders was the rule that missed all of those.
  const moduleDirs = new Set(
    index
      .files()
      .filter((f) => f.path.endsWith('.tf'))
      .map((f) => dirName(f.path)),
  );

  const distance = (dir: string): number | undefined => {
    const direct = rank.get(dir);
    // an ancestor is in the module's own chain, module or not
    if (direct !== undefined) return direct;
    if (moduleDirs.has(dir)) return undefined;
    let cur = dir;
    let cost = 0;
    for (let depth = 1; depth <= MAX_VARS_DEPTH; depth++) {
      // descending inside the module's own tree is never a detour, whatever the
      // folder is called: `infra/deploy/` belongs to `infra`. Charging it the
      // plain step put it below every file in the module's parent, and behind
      // enough of those it fell off the end of the list.
      const own = cur.startsWith(`${moduleDir}/`);
      cost += own || VAR_DIR_NAMES.has(baseName(cur)) ? STEP_NAMED : STEP_PLAIN;
      cur = dirName(cur);
      if (cur === '.' || cur === '') break;
      const i = rank.get(cur);
      if (i !== undefined) return i + cost;
      // a `.tf` file makes a directory somebody's module, and that claim covers
      // its subtree: `other/env/prod.tfvars` drives `other`, exactly as
      // `other/prod.tfvars` does. Stop rather than climb out through it.
      if (moduleDirs.has(cur)) return undefined;
    }
    return undefined;
  };

  const scored: { c: TfvarsCandidate; d: number; named: number }[] = [];
  for (const file of index.files()) {
    if (!file.path.endsWith('.tfvars')) continue;
    const dir = dirName(file.path);
    if (dir === moduleDir) {
      scored.push({
        c: { path: file.path, group: 'module', label: baseName(file.path) },
        d: -1,
        named: 0,
      });
      continue;
    }
    const d = distance(dir);
    if (d === undefined) continue;
    scored.push({
      c: { path: file.path, group: 'nearby', label: relativeTo(moduleDir, file.path) },
      d,
      // at equal distance a folder that says what it is goes first
      named: VAR_DIR_NAMES.has(baseName(dir)) ? 0 : 1,
    });
  }
  scored.sort((a, b) => a.d - b.d || a.named - b.named || a.c.label.localeCompare(b.c.label));
  return {
    candidates: scored.slice(0, MAX_CANDIDATES).map((s) => s.c),
    truncated: scored.length > MAX_CANDIDATES,
  };
}

/** Files a module resolves through, lowest precedence first: what Terraform
 *  auto-loads, then the pin. The pin models `-var-file`, so it may live
 *  anywhere — a central `environments/` folder is the common case — and it
 *  merges last even when it is also auto-loaded. A called module gets nothing:
 *  its values come from the call site. */
export function tfvarsChain(
  index: WorkspaceIndex,
  moduleDir: string,
  pinned: string | undefined,
): string[] {
  // externalCallSitesOf, not callSitesOf — the evaluator ignores calls from
  // a module's own tree, so one with an examples/ folder is still a root here
  if (index.externalCallSitesOf(moduleDir).length > 0) return [];
  const files = autoLoadedTfvars(index, moduleDir);
  if (!pinned) return files;
  return [...files.filter((p) => p !== pinned), pinned];
}

/** Pins as stored in workspaceState. Before pins were per-module the key held
 *  a bare path that applied to the directory containing it; that shape is
 *  migrated to exactly that meaning, so an upgrade loses nothing. */
export function readPins(stored: unknown, dirOf: (p: string) => string): Record<string, string> {
  if (typeof stored === 'string') return stored ? { [dirOf(stored)]: stored } : {};
  if (!stored || typeof stored !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [dir, path] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof path === 'string' && path) out[dir] = path;
  }
  return out;
}

export interface HoverContext {
  index: WorkspaceIndex;
  /** the tfvars in force for a module directory (see EvalScope.tfvarsOf) */
  tfvarsOf: (moduleDir: string) => ReadonlyMap<string, TfvarsValue>;
  copyCommand: string;
}

/** The full hover pipeline, VS Code-free: ref-or-definition under the cursor →
 *  resolve through the var→local chain → markdown body. */
/** Module instances re-resolved for the per-instance rows.
 *
 *  MAX_VALUE_CHARS bounds *one* value; nothing bounded how many of them get
 *  built. Each row is an independent full resolve carrying its own fresh
 *  budget, and the row count is whatever the user's config supplies — the
 *  number of places a module is called. A shared module called from many stacks
 *  each passing a distinct value measured 766ms of frozen extension host at 200
 *  sites, and 20s / 18MB of markdown at 100 sites × 90k-char values, all of it
 *  on the synchronous hover path. This is the same class 369bd03 closed for a
 *  single value, left open for the list of them. */
const MAX_CONFLICT_SITES = 8;

/** Total characters the per-instance row list may render, measured as the rows
 *  are built rather than after: the point is not to allocate the megabytes in
 *  the first place. */
const MAX_CONFLICT_CHARS = 20_000;

/** Value characters one per-instance row may show. The budget above cannot bound
 *  a list whose *first* entry already exceeds it, and a row exists to let a
 *  reader tell instances apart, not to print a 90k-char value at each of them. */
const MAX_ROW_VALUE_CHARS = 2_000;

export function computeHover(file: ParsedFile, pos: Pos, ctx: HoverContext): string | undefined {
  const ref = file.refs.find(
    (r) => (r.parts[0] === 'var' || r.parts[0] === 'local') && spanContains(r.span, pos),
  );
  // keep the whole reference, path included — truncating local.cfg.db.host to
  // local.cfg would report the enclosing object instead of the field
  const parts = ref?.parts;
  const def = parts ? undefined : definitionAt(file, pos);
  const target = parts ?? (def ? [def.kind, def.name] : undefined);
  if (!target) return undefined;
  const used = emptyUsage();
  const scope: EvalScope = {
    index: ctx.index,
    moduleDir: ctx.index.moduleDirOf(file.path),
    tfvarsOf: ctx.tfvarsOf,
    used,
  };
  let resolved = resolveRefShaped(target, scope);
  // evaluator reports where call sites split; re-resolving the *whole* target
  // per site (not just the diverged var) shows "app-dev" for
  // local.name = "app-${var.env}" instead of the bare "dev"
  const diverged = used.divergedAt;
  let omitted = 0;
  if (diverged) {
    const sampled = diverged.sites.slice(0, MAX_CONFLICT_SITES);
    omitted = diverged.sites.length - sampled.length;
    const rows = sampled.map((site, i) => ({
      label: diverged.labels[i] ?? '?',
      value: resolveRefShaped(target, {
        ...scope,
        used: emptyUsage(),
        pinnedSites: new Map([...(scope.pinnedSites ?? []), [diverged.moduleDir, site]]),
      }),
    }));
    if (omitted > 0 || new Set(rows.map((r) => r.value.text)).size > 1) {
      // With instances left unread we cannot claim they agree, so the collapse
      // below is not available: listing what was measured is honest, naming one
      // value for all of them would not be.
      for (const row of rows) used.conflicts.set(row.label, row.value);
    } else if (rows[0]) {
      // divergent var never reaches this value (cancels out, or feeds a branch
      // we don't evaluate) — report the agreed value instead of ⟨unknown⟩
      resolved = rows[0].value;
    }
  }
  // for the "not set in …" note — naming a globally selected file would
  // wrongly claim a var was unset in a tfvars that doesn't apply here
  const inForce = [
    ...new Set([...ctx.tfvarsOf(scope.moduleDir).values()].map((v) => baseName(v.file))),
  ].sort();
  return hoverMarkdown({
    target,
    value: resolved.text,
    shape: resolved.shape,
    used,
    tfvarsNames: inForce,
    copyCommand: ctx.copyCommand,
    conflictsOmitted: omitted,
  });
}

export interface HoverParts {
  /** e.g. ['var', 'env'] */
  target: string[];
  value: string;
  /** What `value` is, since its text can't say: a string reading "[a, b]" is
   *  spelled exactly like a two-element list. Defaults to a scalar, which is
   *  what a caller handing over a plain string means. */
  shape?: ValueShape;
  used: EvalUsage;
  /** basenames of the tfvars files in force for this module, if any */
  tfvarsNames?: string[];
  copyCommand: string;
  /** instances past MAX_CONFLICT_SITES that were never resolved */
  conflictsOmitted?: number;
}

/** Markdown body of the resolved-value hover: value, real provenance, copy link.
 *  When module instances pass different values, lists one value per instance. */
export function hoverMarkdown({
  target,
  value,
  shape = 'scalar',
  used,
  tfvarsNames,
  copyCommand,
  conflictsOmitted = 0,
}: HoverParts): string {
  // a block label is whatever the parser accepted between the quotes, and this
  // hover renders trusted, so the name needs the same escaping as every other
  // untrusted string here. An ordinary identifier is left alone: it has nothing
  // markdown reacts to, and escaping it would spell `name_prefix` as
  // `name\_prefix` in the one line the reader is here to read.
  const name = target.map((p) => (/^[\w-]+$/.test(p) ? p : escapeMd(p))).join('.');
  // encodeURIComponent leaves parens alone, and an unescaped ) closes the link
  // early — cidr(10.0.0.0/8) would copy a truncated string
  const copyLink = (v: string) =>
    `[Copy value](command:${copyCommand}?${encodeURIComponent(JSON.stringify([v])).replace(
      /[()]/g,
      (c) => (c === '(' ? '%28' : '%29'),
    )})`;

  if (used.conflicts.size > 0) {
    // per row, because that is the case where one instance fits a limit and
    // another doesn't — a single count for "the" value would be the same lie
    // about which one won that the rows exist to avoid
    const rows: string[] = [];
    let spent = 0;
    let dropped = conflictsOmitted;
    for (const [label, v] of used.conflicts) {
      const count = charNote(v.text, v.shape);
      const shown = count === undefined ? '' : ` (${count})`;
      // One row is a per-instance summary, not the value itself: at full length
      // a single 90k-char instance rendered ~120k of markdown on its own, since
      // `copyLink` percent-encodes a JSON string and runs 2-3x its input. The
      // copy link goes with the truncation rather than following it — copying a
      // clipped value would put text on the clipboard that is not what the
      // instance holds, and `charNote` already reports the real size.
      const clipped = v.text.length > MAX_ROW_VALUE_CHARS;
      const body = clipped ? `${v.text.slice(0, MAX_ROW_VALUE_CHARS)}…` : v.text;
      const copy = clipped ? '' : ` — ${copyLink(v.text)}`;
      const row = `- ${escapeMd(label)}: ${inlineCode(body)}${shown}${copy}`;
      // measured as they are built: `copyLink` alone is 2-3x the value it
      // encodes, so rendering every row and trimming afterwards still pays the
      // whole allocation the cap exists to avoid
      if (spent + row.length > MAX_CONFLICT_CHARS && rows.length > 0) {
        dropped += used.conflicts.size - rows.length;
        break;
      }
      rows.push(row);
      spent += row.length;
    }
    const more = dropped > 0 ? `\n- …and ${dropped} more instance${dropped === 1 ? '' : 's'}` : '';
    return `**${name}** differs per module instance:\n\n${rows.join('\n')}${more}`;
  }

  const origins: string[] = [];
  // with per-module tfvars, only the evaluator can name the file it came from
  const fromFiles = [...new Set([...used.tfvarsFiles].map(baseName))].sort();
  if (fromFiles.length > 0) origins.push(`from ${fromFiles.map(escapeMd).join(', ')}`);
  if (used.defaults.size > 0) {
    const files = [...new Set([...used.defaults.values()].map(baseName))];
    origins.push(`default in ${files.map(escapeMd).join(', ')}`);
  }
  if (used.calls.size > 0) origins.push(`via ${[...used.calls].map(escapeMd).join(' → ')}`);

  // one metadata line under the value rather than a stack of italics: length
  // first, because a resolved name is usually on its way into a field with a
  // hard ceiling — an AWS target group name stops at 32 characters — and this
  // is what says so before apply does. Nothing to count for ⟨unknown⟩, whose
  // length is the placeholder's own.
  const meta: string[] = [];
  const count = charNote(value, shape);
  if (count !== undefined) meta.push(count);
  if (origins.length > 0) meta.push(origins.join(' + '));
  else if (target[0] === 'var' && value === UNKNOWN) {
    const where =
      tfvarsNames && tfvarsNames.length > 0
        ? tfvarsNames.map(escapeMd).join(', ')
        : 'any tfvars for this module';
    meta.push(`no value: not set in ${where} and no default`);
  }
  const note = meta.length > 0 ? `\n\n_${meta.join(' · ')}_` : '';
  return `**${name}** = ${inlineCode(value)}${note}\n\n${copyLink(value)}`;
}

/** Length of the real value, spelled for a human, or nothing when there is no
 *  real length to report. Code points rather than UTF-16 units, and counted
 *  before `inlineCode` escapes anything, so a newline is the one character it
 *  is and not the two of its `\n` spelling.
 *
 *  Two things have no length worth reporting. A value carrying ⟨unknown⟩
 *  anywhere — the whole value, or one slot of `"app-${var.missing}"` — has no
 *  length yet, and the point of the count is to catch a name that won't fit
 *  before apply does; a number measured on the placeholder's own spelling would
 *  answer that question wrongly, which is worse than not answering it.
 *
 *  A list or object has no length either: `[a, b]` is this hover's notation for
 *  two values, and its brackets and separator are punctuation nobody's
 *  infrastructure will ever contain. Only the shape can say so — the text of a
 *  string reading "[a, b]" is identical. */
function charNote(v: string, shape: ValueShape): string | undefined {
  if (shape !== 'scalar' || v.includes(UNKNOWN)) return undefined;
  const n = [...v].length;
  return `${n} ${n === 1 ? 'char' : 'chars'}`;
}

/** Escape anything that can open a link, code span, autolink, or emphasis, so
 *  labels/filenames we don't control render literally. Bare parens are safe
 *  — no unescaped `[` means no inline link can form. */
function escapeMd(v: string): string {
  return v.replace(/[\\`[\]<>*_~]/g, '\\$&');
}

/** Untrusted text as an inline code span that can't break out: the delimiter
 *  is longer than any backtick run inside, so a crafted value can't inject a
 *  command link into a trusted hover.
 *
 *  Line breaks keep their HCL-escaped spelling — a code span can't hold a
 *  blank line (it ends the paragraph and spills the tail as markdown) and a
 *  lone \n silently becomes a space. A fence would fix only the first and
 *  break the conflict-row list, which is inline. Copy still yields real bytes. */
function inlineCode(v: string): string {
  const shown = v.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const longestRun = (shown.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const pad = shown === '' || shown.startsWith('`') || shown.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${shown}${pad}${fence}`;
}
