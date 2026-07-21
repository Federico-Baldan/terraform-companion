import { attrOf, stripQuotes, walkBlocks } from '../core/hcl';
import type { LintFinding, ParsedFile, TfAttr } from '../core/model';
import { parseConstraint } from '../registry/constraints';
import { isRegistryModuleSource } from './versionLens';

export interface HygieneOptions {
  variableDocs: boolean;
}

/** Operators that cap the range — a constraint of only >=, > and != drifts
 *  into the next major unnoticed. `~>` needs two segments; see `clauseAdmits`
 *  in registry/constraints for why one caps nothing. */
const UPPER_BOUND_OPS = new Set(['=', '<', '<=']);

function capsRange(op: string, version: string): boolean {
  if (op === '~>') return version.trim().split('.').length >= 2;
  return UPPER_BOUND_OPS.has(op);
}

function unboundedFinding(version: TfAttr, what: 'provider' | 'module'): LintFinding | undefined {
  const clauses = parseConstraint(stripQuotes(version.valueText));
  if (clauses.length === 0 || clauses.some((c) => capsRange(c.op, c.version))) return undefined;
  const bareTilde = clauses.find((c) => c.op === '~>');
  return {
    code: 'hygiene.unboundedConstraint',
    message: bareTilde
      ? `"~> ${bareTilde.version}" has no upper bound (a single segment caps nothing): "~> ${bareTilde.version}.0" stops at the next major ${what} release.`
      : `Constraint has no upper bound: a major ${what} update can break the plan. Prefer "~>".`,
    span: version.span,
  };
}

export function detectVersionHygiene(file: ParsedFile, opts: HygieneOptions): LintFinding[] {
  const findings: LintFinding[] = [];
  walkBlocks(file.blocks, (block) => {
    if (block.kind === 'module') {
      const source = attrOf(block, 'source');
      if (!source || !isRegistryModuleSource(stripQuotes(source.valueText))) return;
      const version = attrOf(block, 'version');
      if (!version) {
        findings.push({
          code: 'hygiene.moduleUnpinned',
          message: `Module "${block.labels[0] ?? '?'}" has no version: environments can silently drift apart.`,
          span: source.span,
        });
        return;
      }
      const unbounded = unboundedFinding(version, 'module');
      if (unbounded) findings.push(unbounded);
    } else if (block.kind === 'provider_requirement') {
      const version = attrOf(block, 'version');
      if (!version) return;
      const unbounded = unboundedFinding(version, 'provider');
      if (unbounded) findings.push(unbounded);
    } else if (block.kind === 'variable' && opts.variableDocs) {
      const missing = ['description', 'type'].filter((name) => !attrOf(block, name));
      if (missing.length > 0) {
        findings.push({
          code: 'hygiene.variableDocs',
          message: `variable "${block.labels[0] ?? '?'}" is missing ${missing.join(' and ')}.`,
          span: {
            start: block.span.start,
            end: {
              row: block.span.start.row,
              column: block.span.start.column + 'variable'.length,
            },
          },
        });
      }
    }
  });
  return findings;
}
