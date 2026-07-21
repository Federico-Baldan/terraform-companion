import { describe, expect, it } from 'vitest';
import {
  latestAdmitted,
  latestStable,
  lensText,
  parseConstraint,
} from '../src/registry/constraints';

/** What the lens would render for a constraint against a set of published
 *  versions: the newest release the constraint admits, and the newest to
 *  exist at all. */
function lens(versions: string[], constraint: string): string | undefined {
  const installed = latestAdmitted(versions, constraint);
  const newest = latestStable(versions);
  if (!installed || !newest) return undefined;
  return lensText(constraint, installed, newest);
}

describe('clause order is irrelevant (Terraform ANDs them unordered)', () => {
  const versions = ['4.0.0', '5.0.0', '5.98.0', '6.2.0'];

  it('finds the floor wherever it is written', () => {
    // a ceiling typed first used to become the baseline, hiding the lens entirely
    expect(lens(versions, '< 6.0, >= 5.0')).toBe(lens(versions, '>= 5.0, < 6.0'));
    expect(lens(versions, '< 6.0, >= 5.0')).toContain('1 major');
  });

  it('ignores != when picking the baseline', () => {
    // an exclusion is not a floor: 5.0 is
    expect(lens(versions, '!= 4.5, >= 5.0, < 6.0')).toBe(lens(versions, '>= 5.0, != 4.5, < 6.0'));
    expect(lens(versions, '!= 4.5, >= 5.0, < 6.0')).toContain('1 major');
  });

  it('takes the highest floor when several are present', () => {
    // from 5.0 the newest is one major away; from 3.0 it would be three
    expect(lens(versions, '>= 3.0, >= 5.0, < 6.0')).toContain('1 major');
  });
});

describe('latestAdmitted', () => {
  const versions = ['4.0.0', '5.98.0', '6.2.0'];

  it('offers the newest release the ceiling admits, not the global latest', () => {
    expect(latestAdmitted(versions, '>= 4.0, < 6.0')).toBe('5.98.0');
  });

  it('is the plain latest when nothing constrains it', () => {
    expect(latestAdmitted(versions, '')).toBe('6.2.0');
    expect(latestAdmitted(versions, '>= 4.0')).toBe('6.2.0');
  });

  it('applies the pessimistic ceiling ~> puts on its last written segment', () => {
    // that a major bump is routine is the lens's story to tell, not a reason
    // to misreport what terraform would install
    expect(latestAdmitted(versions, '~> 4.0')).toBe('4.0.0');
    expect(latestAdmitted(['5.34.0', '5.34.9', '5.98.0'], '~> 5.34.0')).toBe('5.34.9');
    expect(latestAdmitted(['5.34.0', '5.98.0', '6.2.0'], '~> 5.34')).toBe('5.98.0');
  });

  it('returns undefined when nothing satisfies the ceiling', () => {
    expect(latestAdmitted(['6.0.0', '6.2.0'], '< 5.0')).toBeUndefined();
  });

  it('treats a single-segment ~> as a bare floor, as go-version does', () => {
    expect(latestAdmitted(['5.34.0', '5.98.0', '6.2.0'], '~> 5')).toBe('6.2.0');
    expect(lens(['5.34.0', '5.98.0', '6.2.0'], '~> 5')).toContain('already allowed');
  });

  it('honours != exclusions', () => {
    // `!=` is how an author pins away a known-broken release
    const published = ['5.0.0', '5.50.0', '5.98.0'];
    expect(latestAdmitted(published, '>= 5.0, != 5.98.0')).toBe('5.50.0');
    expect(latestAdmitted(published, '~> 5.0, != 5.98.0')).toBe('5.50.0');
    expect(latestAdmitted(published, '>= 5.0')).toBe('5.98.0');
  });
});

describe('lens text tells the three situations apart', () => {
  const versions = ['4.0.0', '5.0.0', '5.34.0', '5.98.0', '6.2.0'];

  it('a pin below the newest release is behind it', () => {
    expect(lens(versions, '5.34.0')).toBe('→ 6.2.0 available (1 major behind)');
    expect(lens(['5.34.0', '5.98.0'], '5.34.0')).toBe('→ 5.98.0 available (64 minors behind)');
    expect(lens(['5.98.0', '5.98.1'], '5.98.0')).toBe('→ 5.98.1 available (patch)');
  });

  it('an open constraint that already admits the newest release is not behind', () => {
    // calling this "1 major behind" also contradicted the unbounded-constraint
    // diagnostic sitting on the same line
    expect(lens(versions, '>= 5.0')).toBe('→ 6.2.0 is the newest (already allowed)');
    expect(lens(versions, '> 5.0')).toBe('→ 6.2.0 is the newest (already allowed)');
  });

  it('a constraint capping below the newest release is blocking it', () => {
    expect(lens(versions, '~> 5.34')).toBe('→ 6.2.0 blocked by your constraint (1 major)');
    // counted from what it installs (5.98.0), not from its 4.0 floor
    expect(lens(versions, '>= 4.0, < 6.0')).toBe('→ 6.2.0 blocked by your constraint (1 major)');
    // an != that excludes the newest release blocks it just as a ceiling does
    expect(lens(versions, '>= 5.0, != 6.2.0')).toContain('blocked by your constraint');
  });

  it('says nothing when no release newer than the floor exists', () => {
    expect(lens(['5.98.0'], '5.98.0')).toBeUndefined();
    expect(lens(['5.98.0'], '~> 5.98')).toBeUndefined();
    expect(lens(['5.98.0'], '6.0.0')).toBeUndefined();
  });

  it('coerces constraint text like "~> 5.34" for the comparison', () => {
    expect(lens(['5.34.0', '5.98.0'], '~> 5.34')).toContain('5.98.0');
  });
});

describe('version constraints', () => {
  it('parses pessimistic, comparison, exact and bare constraints', () => {
    expect(parseConstraint('~> 5.34.0')).toEqual([{ op: '~>', version: '5.34.0' }]);
    expect(parseConstraint('>= 4.0, < 6')).toEqual([
      { op: '>=', version: '4.0' },
      { op: '<', version: '6' },
    ]);
    expect(parseConstraint('= 1.2.3')).toEqual([{ op: '=', version: '1.2.3' }]);
    expect(parseConstraint('1.2.3')).toEqual([{ op: '=', version: '1.2.3' }]);
  });

  /** A constraint is half-typed for as long as it takes to type it, and the
   *  lens recomputes every keystroke: ">=" is literally ">= 5.0" mid-type. */
  it('leaves an operator with no version unparsed rather than inventing one', () => {
    for (const text of ['>=', '>= ', '~>', '<=', '!=', '>', '=']) {
      expect(parseConstraint(text)).toEqual([]);
    }
  });

  it('finds the latest stable version, skipping pre-releases', () => {
    expect(latestStable(['5.98.0', '6.0.0-beta1', '5.34.0', '4.9.9'])).toBe('5.98.0');
    expect(latestStable([])).toBeUndefined();
  });
});

describe('behind vs blocked', () => {
  const versions = ['5.0.0', '5.5.0', '5.98.0'];

  it('calls a ceiling-only constraint blocked, not "available"', () => {
    // with no floor the pivot falls back to the ceiling, which used to be
    // compared against itself
    const text = lens(versions, '<= 5.5.0');
    expect(text).toContain('blocked by your constraint');
    expect(text).not.toContain('available');
  });

  it('still calls an outdated pin "behind"', () => {
    // a pin is a floor: bumping it is exactly what gets you to the newest
    expect(lens(versions, '5.0.0')).toContain('behind');
  });

  it('calls a ~> pin blocked, like any other cap', () => {
    // "~> 5.0.0" is ">= 5.0.0, < 5.1.0", capping below 5.98.0 exactly as
    // "<= 5.5.0" does — see the release-independence tests below
    expect(lens(versions, '~> 5.0.0')).toContain('blocked by your constraint');
  });

  it('still calls an explicit upper bound blocked', () => {
    expect(lens(versions, '>= 5.0, < 5.6')).toContain('blocked by your constraint');
  });

  // "has it moved past its floor" answers a different question: for >= that
  // implies a ceiling, but for ~> it's routine, so a single patch release
  // used to flip the same constraint from "behind" to "blocked"
  it('gives a ~> pin the same verdict whether or not its line got a patch', () => {
    const noPatch = lens(['5.34.0', '6.0.0'], '~> 5.34.0');
    const withPatch = lens(['5.34.0', '5.34.9', '6.0.0'], '~> 5.34.0');
    expect(withPatch).toBe(noPatch);
    expect(noPatch).toContain('blocked by your constraint');
  });

  it('says the same for a minor-precision ~> pin', () => {
    const noRelease = lens(['5.34.0', '6.0.0'], '~> 5.34');
    const withRelease = lens(['5.34.0', '5.98.0', '6.0.0'], '~> 5.34');
    expect(withRelease).toBe(noRelease);
    expect(noRelease).toContain('blocked by your constraint');
  });

  it('gives an exact pin the same verdict whatever else shipped', () => {
    expect(lens(['5.34.0', '6.0.0'], '5.34.0')).toContain('behind');
    expect(lens(['5.34.0', '5.34.9', '6.0.0'], '5.34.0')).toContain('behind');
  });

  // the flip side of the two tests above: the case the floor-comparison protected
  it('keeps calling a capped constraint blocked once it moved past its floor', () => {
    expect(lens(['5.0.0', '5.98.0', '6.0.0'], '>= 5.0, < 6.0')).toContain(
      'blocked by your constraint',
    );
    expect(lens(['5.0.0', '5.98.0'], '>= 5.0, != 5.98.0')).toContain('blocked by your constraint');
  });
});

describe('a constraint that matches nothing published', () => {
  // the lens used to vanish here, hiding the constraint most worth looking at
  it('says so instead of rendering no lens', () => {
    expect(lensText('4.0.0', undefined, '6.2.0')).toBe(
      '→ 6.2.0 available (your constraint matches no published release)',
    );
  });

  it('latestAdmitted reports it by returning undefined', () => {
    expect(latestAdmitted(['5.0.0', '5.98.0', '6.2.0'], '4.0.0')).toBeUndefined();
  });
});
