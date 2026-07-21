import * as semver from 'semver';

export interface ConstraintClause {
  op: string;
  version: string;
}

export function parseConstraint(text: string): ConstraintClause[] {
  const clauses: ConstraintClause[] = [];
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    // anchoring the version to a digit stops alternation backtracking — a
    // half-typed ">=" would otherwise parse as `>` with version "="
    const m = part.match(/^(~>|>=|<=|!=|[=<>])?\s*(\d.*)$/);
    if (!m) continue;
    clauses.push({ op: m[1] ?? '=', version: (m[2] ?? '').trim() });
  }
  return clauses;
}

export function latestStable(versions: string[]): string | undefined {
  let best: string | undefined;
  for (const v of versions) {
    const parsed = semver.coerce(v, { includePrerelease: true });
    if (!parsed || parsed.prerelease.length > 0 || semver.prerelease(v)) continue;
    if (!best || semver.gt(parsed.version, best)) best = parsed.version;
  }
  return best;
}

/** Ceilings a bump preserves. `~>` is excluded on purpose — it's the clause
 *  the bump replaces, since moving a `~>` pin up is routine, while an
 *  explicit `< 6.0` is a decision the lens must not quietly undo. */
export const CEILING_OPS = new Set(['<', '<=']);

/** Terraform operator semantics, not semver's. */
export function clauseAdmits(clause: ConstraintClause, version: string): boolean {
  const target = semver.coerce(version);
  const bound = semver.coerce(clause.version);
  if (!target || !bound) return true;
  const [t, b] = [target.version, bound.version];
  switch (clause.op) {
    case '<':
      return semver.lt(t, b);
    case '<=':
      return semver.lte(t, b);
    case '>':
      return semver.gt(t, b);
    case '>=':
      return semver.gte(t, b);
    case '!=':
      return !semver.eq(t, b);
    case '=':
      return semver.eq(t, b);
    case '~>': {
      // go-version equates the segments before the last one written, so "~> 5"
      // equates nothing and admits 6.x — not semver's ^/~, which special-case
      // 0.x while Terraform doesn't
      if (semver.lt(t, b)) return false;
      const segments = clause.version.trim().split('.').length;
      if (segments <= 1) return true;
      return segments >= 3
        ? target.major === bound.major && target.minor === bound.minor
        : target.major === bound.major;
    }
    default:
      return true;
  }
}

/** Clauses are an unordered AND, so the floor is not necessarily written first. */
export const LOWER_BOUND_OPS = new Set(['>=', '>', '~>', '=']);

/** The clause an update replaces: highest lower bound, else the first clause. */
export function pivotClause(clauses: ConstraintClause[]): ConstraintClause | undefined {
  let best: ConstraintClause | undefined;
  let bestVersion: string | undefined;
  for (const clause of clauses) {
    if (!LOWER_BOUND_OPS.has(clause.op)) continue;
    const coerced = semver.coerce(clause.version);
    if (!coerced) continue;
    if (!bestVersion || semver.gt(coerced.version, bestVersion)) {
      best = clause;
      bestVersion = coerced.version;
    }
  }
  return best ?? clauses[0];
}

/** Newest stable release the constraint's own ceilings admit. */
export function latestAdmitted(versions: string[], constraint: string): string | undefined {
  const clauses = parseConstraint(constraint);
  return latestStable(versions.filter((v) => clauses.every((c) => clauseAdmits(c, v))));
}

/** Counted at the coarsest unit that moved. */
function distance(from: semver.SemVer, to: semver.SemVer): { n: number; unit: string } {
  const majors = to.major - from.major;
  if (majors > 0) return { n: majors, unit: 'major' };
  const minors = to.minor - from.minor;
  if (minors > 0) return { n: minors, unit: 'minor' };
  return { n: 0, unit: 'patch' };
}

/** CodeLens title. `installed` is what the constraint resolves to today, or
 *  undefined when it admits nothing published. */
export function lensText(
  constraint: string,
  installed: string | undefined,
  newest: string,
): string | undefined {
  const clauses = parseConstraint(constraint);
  const floor = semver.coerce(pivotClause(clauses)?.version ?? constraint);
  const top = semver.coerce(newest);
  if (!floor || !top) return undefined;
  const got = installed === undefined ? undefined : semver.coerce(installed);
  if (!got) return `→ ${newest} available (your constraint matches no published release)`;
  if (!semver.gt(top.version, floor.version)) return undefined;
  if (semver.eq(got.version, top.version)) {
    return `→ ${newest} is the newest (already allowed)`;
  }
  // From what the constraint installs, not from its floor.
  const { n, unit } = distance(got, top);
  const amount = n === 0 ? 'patch' : `${n} ${unit}${n > 1 ? 's' : ''}`;
  // An exact pin is the only shape you clear by raising it; every other excludes
  // `newest` with a range, which is "blocked" rather than "behind".
  const pivot = pivotClause(clauses);
  const isExactPin =
    pivot?.op === '=' && clauses.every((c) => c === pivot || clauseAdmits(c, newest));
  return isExactPin
    ? `→ ${newest} available (${n === 0 ? 'patch' : `${amount} behind`})`
    : `→ ${newest} blocked by your constraint (${amount})`;
}
