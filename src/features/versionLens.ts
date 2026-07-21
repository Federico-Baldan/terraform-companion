import { attrOf, stripQuotes, walkBlocks } from '../core/hcl';
import type { ParsedFile, Span } from '../core/model';
import {
  CEILING_OPS,
  type ConstraintClause,
  clauseAdmits,
  parseConstraint,
  pivotClause,
} from '../registry/constraints';

export interface VersionTarget {
  /** where the CodeLens anchors (the version attribute) */
  span: Span;
  /** the constraint string value to replace on update (including quotes) */
  valueSpan: Span;
  source: string;
  isModule: boolean;
  constraint: string;
}

const REGISTRY_MODULE = /^[\w.-]+\/[\w.-]+\/[\w.-]+$/;
const DEFAULT_REGISTRY_HOST = /^registry\.terraform\.io\//;

/** Terraform allows the default host written out in full, but the API query
 *  and registry URL both expect it absent. */
export function normalizeRegistrySource(raw: string): string {
  return raw.replace(DEFAULT_REGISTRY_HOST, '');
}

/** true for "ns/name/provider" registry sources; local paths and git/http sources are excluded */
export function isRegistryModuleSource(raw: string): boolean {
  if (raw.startsWith('./') || raw.startsWith('../')) return false;
  const base = normalizeRegistrySource(raw).split('//')[0] ?? raw;
  // a dot in the first segment is a hostname, never a registry namespace
  if ((base.split('/')[0] ?? '').includes('.')) return false;
  return REGISTRY_MODULE.test(base);
}

/** Registry slugs. Anything else means the source isn't a public-registry
 *  address, and would build a request URL from unvalidated file content. */
const REGISTRY_SEGMENT = /^[\w-]+$/;

/** Provider addresses may carry a host ("app.terraform.io/acme/mycloud") —
 *  without the two-segment check, private provider names leak to
 *  registry.terraform.io on a request that can only 404. */
export function isRegistryProviderSource(raw: string): boolean {
  const parts = normalizeRegistrySource(raw).split('/');
  if (parts.length !== 2) return false;
  const [namespace, name] = parts;
  return !!namespace && !!name && REGISTRY_SEGMENT.test(namespace) && REGISTRY_SEGMENT.test(name);
}

export function computeVersionTargets(file: ParsedFile): VersionTarget[] {
  const targets: VersionTarget[] = [];
  walkBlocks(file.blocks, (block) => {
    if (block.kind === 'provider_requirement') {
      const source = attrOf(block, 'source');
      const version = attrOf(block, 'version');
      if (!version) return;
      // no source → Terraform implies hashicorp/<name>; default host is
      // stripped so both the API query and registry URL work
      const raw = source
        ? normalizeRegistrySource(stripQuotes(source.valueText))
        : `hashicorp/${block.labels[0] ?? '?'}`;
      if (!isRegistryProviderSource(raw)) return;
      targets.push({
        span: version.span,
        valueSpan: version.valueSpan,
        source: raw,
        isModule: false,
        constraint: stripQuotes(version.valueText),
      });
    } else if (block.kind === 'module') {
      const source = attrOf(block, 'source');
      const version = attrOf(block, 'version');
      if (!source || !version) return;
      const raw = normalizeRegistrySource(stripQuotes(source.valueText));
      if (!isRegistryModuleSource(raw)) return;
      const base = raw.split('//')[0] ?? raw;
      targets.push({
        span: version.span,
        valueSpan: version.valueSpan,
        source: base,
        isModule: true,
        constraint: stripQuotes(version.valueText),
      });
    }
  });
  return targets;
}

export function registryUrl(target: VersionTarget): string {
  return target.isModule
    ? `https://registry.terraform.io/modules/${target.source}/latest`
    : `https://registry.terraform.io/providers/${target.source}/latest`;
}

/** Operators kept when bumping: with `latest` as their version they still allow it. */
const PRESERVABLE_OPS = new Set(['~>', '>=', '<=']);

/** Splits a constraint by the ROLE of each clause, not position — clauses are
 *  an unordered AND, so keying off `clauses[0]` deletes whichever bound was
 *  typed first. Computed in one pass so the QuickPick label stays honest. */
function partitionClauses(
  constraint: string,
  latest: string,
): { pivot?: ConstraintClause; ceilings: ConstraintClause[]; dropped: ConstraintClause[] } {
  const clauses = parseConstraint(constraint);
  const pivot = pivotClause(clauses);
  const ceilings: ConstraintClause[] = [];
  const dropped: ConstraintClause[] = [];
  for (const clause of clauses) {
    if (clause === pivot) continue; // replaced by `latest`
    if (CEILING_OPS.has(clause.op) && clauseAdmits(clause, latest)) ceilings.push(clause);
    else dropped.push(clause);
  }
  return { pivot, ceilings, dropped };
}

/** With `~>` the segment count *is* the constraint, so writing the full
 *  version back would demote a minor-range pin to patch-range. Bump keeps
 *  found precision: "~> 5.34" → "~> 5.98", "~> 5.34.0" → "~> 5.98.0". */
function matchPrecision(latest: string, written: string): string {
  const trimmed = written.trim();
  const segments = trimmed.split('.').length;
  const parts = latest.split('.');
  if (segments >= parts.length) return latest;
  // the one precision not worth preserving — go-version caps nothing on a
  // single segment, so "~> 5" is a bare floor; writing it back would emit a
  // constraint versionHygiene immediately flags
  if (segments <= 1) return parts.slice(0, 2).join('.');
  return parts.slice(0, segments).join('.');
}

/** Preserve the bumped clause's operator; fall back to an exact pin for
 *  modules, `~>` for providers. `>`, `<`, `!=` take the fallback since
 *  `<op> latest` would exclude the version being offered. */
export function updatedConstraintText(target: VersionTarget, latest: string): string {
  const fallback = target.isModule ? '=' : '~>';
  const { pivot, ceilings } = partitionClauses(target.constraint, latest);
  const pivotOp = pivot?.op;
  const op = pivotOp && PRESERVABLE_OPS.has(pivotOp) ? pivotOp : pivotOp === '=' ? '=' : fallback;
  // only `~>` reads meaning into the segment count; every other operator
  // compares against the whole version and keeps it in full
  const version = pivot?.op === '~>' ? matchPrecision(latest, pivot.version) : latest;
  const prefix = op === '=' ? '' : `${op} `;
  const tail = ceilings.map((c) => `, ${c.op} ${c.version}`).join('');
  return `"${prefix}${version}${tail}"`;
}

/** Label of the "update" QuickPick choice. Clauses that cannot survive the bump
 *  are spelled out instead of disappearing silently. */
export function updateChoiceLabel(target: VersionTarget, latest: string): string {
  const text = updatedConstraintText(target, latest);
  const dropped = partitionClauses(target.constraint, latest).dropped.map((c) =>
    `${c.op} ${c.version}`.trim(),
  );
  return dropped.length > 0
    ? `Update to ${text} (drops "${dropped.join(', ')}")`
    : `Update to ${text}`;
}
