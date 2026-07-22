import {
  type EvalScope,
  type EvalUsage,
  emptyUsage,
  resolveRef,
  type TfvarsValue,
  UNKNOWN,
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

/** Directory names that conventionally hold one tfvars per environment. A
 *  central vars folder is the layout Terraform's own docs reach for once a
 *  root module serves more than one environment. */
const VAR_DIR_NAMES = new Set(['env', 'envs', 'vars', 'tfvars', 'environments']);

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
 *  module can't walk up to the filesystem root. */
function ancestorsWithin(dir: string, roots: string[]): string[] {
  const root = roots.find((r) => dir === r || dir.startsWith(`${r}/`));
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
 *  then ancestors and their conventional vars folders. Deliberately not "every
 *  tfvars in the workspace" — a monorepo has hundreds, and all but a handful
 *  belong to other modules. Browse covers the rest. */
export function tfvarsCandidates(
  index: WorkspaceIndex,
  moduleDir: string,
  roots: string[],
): { candidates: TfvarsCandidate[]; truncated: boolean } {
  const ancestors = ancestorsWithin(moduleDir, roots);
  // a dir qualifies when it is an ancestor, or a conventional vars folder
  // hanging off one — which also catches siblings of the module itself
  const distance = (dir: string): number | undefined => {
    const direct = ancestors.indexOf(dir);
    if (direct !== -1) return direct;
    if (VAR_DIR_NAMES.has(dir.slice(dir.lastIndexOf('/') + 1))) {
      const parent = ancestors.indexOf(dirName(dir));
      if (parent !== -1) return parent + 0.5;
    }
    return undefined;
  };

  const scored: { c: TfvarsCandidate; d: number }[] = [];
  for (const file of index.files()) {
    if (!file.path.endsWith('.tfvars')) continue;
    const dir = dirName(file.path);
    if (dir === moduleDir) {
      scored.push({ c: { path: file.path, group: 'module', label: baseName(file.path) }, d: -1 });
      continue;
    }
    const d = distance(dir);
    if (d === undefined) continue;
    scored.push({
      c: { path: file.path, group: 'nearby', label: relativeTo(moduleDir, file.path) },
      d,
    });
  }
  scored.sort((a, b) => a.d - b.d || a.c.label.localeCompare(b.c.label));
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
  tfvarsOf: (moduleDir: string) => Map<string, TfvarsValue>;
  copyCommand: string;
}

/** The full hover pipeline, VS Code-free: ref-or-definition under the cursor →
 *  resolve through the var→local chain → markdown body. */
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
  let value = resolveRef(target, scope);
  // evaluator reports where call sites split; re-resolving the *whole* target
  // per site (not just the diverged var) shows "app-dev" for
  // local.name = "app-${var.env}" instead of the bare "dev"
  const diverged = used.divergedAt;
  if (diverged) {
    const rows = diverged.sites.map((site, i) => ({
      label: diverged.labels[i] ?? '?',
      value: resolveRef(target, {
        ...scope,
        used: emptyUsage(),
        pinnedSites: new Map([...(scope.pinnedSites ?? []), [diverged.moduleDir, site]]),
      }),
    }));
    if (new Set(rows.map((r) => r.value)).size > 1) {
      for (const row of rows) used.conflicts.set(row.label, row.value);
    } else if (rows[0]) {
      // divergent var never reaches this value (cancels out, or feeds a branch
      // we don't evaluate) — report the agreed value instead of ⟨unknown⟩
      value = rows[0].value;
    }
  }
  // for the "not set in …" note — naming a globally selected file would
  // wrongly claim a var was unset in a tfvars that doesn't apply here
  const inForce = [
    ...new Set([...ctx.tfvarsOf(scope.moduleDir).values()].map((v) => baseName(v.file))),
  ].sort();
  return hoverMarkdown({
    target,
    value,
    used,
    tfvarsNames: inForce,
    copyCommand: ctx.copyCommand,
  });
}

export interface HoverParts {
  /** e.g. ['var', 'env'] */
  target: string[];
  value: string;
  used: EvalUsage;
  /** basenames of the tfvars files in force for this module, if any */
  tfvarsNames?: string[];
  copyCommand: string;
}

/** Markdown body of the resolved-value hover: value, real provenance, copy link.
 *  When module instances pass different values, lists one value per instance. */
export function hoverMarkdown({
  target,
  value,
  used,
  tfvarsNames,
  copyCommand,
}: HoverParts): string {
  const name = target.join('.');
  // encodeURIComponent leaves parens alone, and an unescaped ) closes the link
  // early — cidr(10.0.0.0/8) would copy a truncated string
  const copyLink = (v: string) =>
    `[Copy value](command:${copyCommand}?${encodeURIComponent(JSON.stringify([v])).replace(
      /[()]/g,
      (c) => (c === '(' ? '%28' : '%29'),
    )})`;

  if (used.conflicts.size > 0) {
    const rows = [...used.conflicts].map(
      ([label, v]) => `- ${escapeMd(label)}: ${inlineCode(v)} — ${copyLink(v)}`,
    );
    return `**${name}** differs per module instance:\n\n${rows.join('\n')}`;
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

  let note = origins.length > 0 ? `\n\n_(${origins.join(' + ')})_` : '';
  if (note === '' && target[0] === 'var' && value === UNKNOWN) {
    const where =
      tfvarsNames && tfvarsNames.length > 0
        ? tfvarsNames.map(escapeMd).join(', ')
        : 'any tfvars for this module';
    note = `\n\n_(no value: not set in ${where} and no default)_`;
  }
  return `**${name}** = ${inlineCode(value)}${note}\n\n${copyLink(value)}`;
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
