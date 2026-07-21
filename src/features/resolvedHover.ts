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
