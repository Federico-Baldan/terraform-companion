import { describe, expect, it } from 'vitest';
import { TrackedDirs } from '../src/core/trackedDirs';

describe('TrackedDirs', () => {
  it('reports every ancestor of a tracked path', () => {
    const t = new TrackedDirs();
    t.add('/repo/modules/net/main.tf');
    expect(t.mayContain('/repo/modules/net')).toBe(true);
    expect(t.mayContain('/repo/modules')).toBe(true);
    expect(t.mayContain('/repo')).toBe(true);
  });

  it('rejects folders that hold nothing tracked', () => {
    const t = new TrackedDirs();
    t.add('/repo/modules/net/main.tf');
    // the build trees whose deletion used to trigger a full sweep per path
    expect(t.mayContain('/repo/target/debug/build/x')).toBe(false);
    expect(t.mayContain('/repo/dist')).toBe(false);
    expect(t.mayContain('/other')).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as an ancestor', () => {
    const t = new TrackedDirs();
    t.add('/repo/mod/main.tf');
    // '/repo/mo' is a string prefix of '/repo/mod' but not a parent directory
    expect(t.mayContain('/repo/mo')).toBe(false);
    expect(t.mayContain('/repo/module')).toBe(false);
  });

  it('never reports the tracked file itself, only its directories', () => {
    const t = new TrackedDirs();
    t.add('/repo/main.tf');
    // the .tf watcher relies on this to skip pathsUnder for ordinary files
    expect(t.mayContain('/repo/main.tf')).toBe(false);
    expect(t.mayContain('/repo')).toBe(true);
  });

  it('covers a directory that is itself named like a .tf file', () => {
    const t = new TrackedDirs();
    t.add('/repo/weird.tf/inner.tf');
    expect(t.mayContain('/repo/weird.tf')).toBe(true);
  });

  it('matches regardless of separator or a trailing slash', () => {
    const t = new TrackedDirs();
    t.add('C:\\repo\\modules\\main.tf');
    expect(t.mayContain('C:\\repo\\modules')).toBe(true);
    expect(t.mayContain('C:/repo/modules')).toBe(true);
    expect(t.mayContain('C:/repo/modules/')).toBe(true);
  });

  it('keeps ancestors of every path added, not just the last', () => {
    const t = new TrackedDirs();
    t.add('/repo/a/one.tf');
    t.add('/repo/b/two.tf');
    // the early-out on an already-known ancestor must not stop the second climb
    expect(t.mayContain('/repo/a')).toBe(true);
    expect(t.mayContain('/repo/b')).toBe(true);
  });

  it('answers in constant time as the tracked set grows', () => {
    const t = new TrackedDirs();
    for (let i = 0; i < 20_000; i++) t.add(`/repo/modules/m${i}/main.tf`);
    const start = performance.now();
    for (let i = 0; i < 100_000; i++) t.mayContain(`/repo/target/debug/build/artifact-${i}`);
    // the scan this replaced was ~5s for a fifth of these lookups
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
