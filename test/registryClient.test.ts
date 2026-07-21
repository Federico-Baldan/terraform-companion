import { describe, expect, it } from 'vitest';
import {
  CACHE_MAX_AGE_MS,
  type CacheEntry,
  FAILURE_COOLDOWN_MS,
  failureCooldownMs,
  MAX_FAILURE_COOLDOWN_MS,
  pruneRegistryCache,
  RegistryClient,
  type RegistryStore,
} from '../src/registry/client';

function mapStore(): RegistryStore {
  const m = new Map<string, CacheEntry>();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

function providerFetch(versions: string[], counter: { n: number }) {
  return (async (url: string) => {
    counter.n++;
    expect(url).toBe('https://registry.terraform.io/v1/providers/hashicorp/aws/versions');
    return {
      ok: true,
      json: async () => ({ versions: versions.map((v) => ({ version: v })) }),
    };
  }) as unknown as typeof fetch;
}

const TTL = 1000;

describe('registry client', () => {
  it('fetches provider versions and caches them', async () => {
    const counter = { n: 0 };
    let time = 0;
    const client = new RegistryClient(
      mapStore(),
      providerFetch(['5.98.0'], counter),
      TTL,
      () => time,
    );
    expect(await client.providerVersions('hashicorp/aws')).toEqual(['5.98.0']);
    expect(await client.providerVersions('hashicorp/aws')).toEqual(['5.98.0']);
    expect(counter.n).toBe(1);
    time = TTL + 1;
    await client.providerVersions('hashicorp/aws');
    expect(counter.n).toBe(2);
  });

  it('dedupes concurrent in-flight requests', async () => {
    const counter = { n: 0 };
    const client = new RegistryClient(mapStore(), providerFetch(['5.98.0'], counter), TTL);
    const [a, b] = await Promise.all([
      client.providerVersions('hashicorp/aws'),
      client.providerVersions('hashicorp/aws'),
    ]);
    expect(a).toEqual(['5.98.0']);
    expect(b).toEqual(['5.98.0']);
    expect(counter.n).toBe(1);
  });

  it('returns undefined on network error with no cache, never throws', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), failing, TTL);
    expect(await client.providerVersions('hashicorp/aws')).toBeUndefined();
  });

  it('serves stale cache when offline after TTL expiry', async () => {
    const store = mapStore();
    let time = 0;
    let fail = false;
    const fetchFn = (async () => {
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ versions: [{ version: '5.98.0' }] }) };
    }) as unknown as typeof fetch;
    const client = new RegistryClient(store, fetchFn, TTL, () => time);
    await client.providerVersions('hashicorp/aws');
    time = TTL + 1;
    fail = true;
    expect(await client.providerVersions('hashicorp/aws')).toEqual(['5.98.0']);
  });

  it('does not cache an empty result, so it can recover after the cooldown', async () => {
    const counter = { n: 0 };
    let payload: string[] = [];
    let time = 0;
    const fetchFn = (async () => {
      counter.n++;
      return { ok: true, json: async () => ({ versions: payload.map((v) => ({ version: v })) }) };
    }) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), fetchFn, TTL, () => time);
    expect(await client.providerVersions('hashicorp/aws')).toEqual([]);
    payload = ['5.98.0'];
    // within the cooldown nothing is refetched — no request per keystroke
    expect(await client.providerVersions('hashicorp/aws')).toBeUndefined();
    expect(counter.n).toBe(1);
    // past it, the next call refetches and recovers: empty was never cached
    time = FAILURE_COOLDOWN_MS + 1;
    expect(await client.providerVersions('hashicorp/aws')).toEqual(['5.98.0']);
    expect(counter.n).toBe(2);
  });

  it('treats a body with no usable version strings as an empty result', async () => {
    const counter = { n: 0 };
    const store = mapStore();
    let payload: unknown = { versions: [{ protocols: ['5'] }, { version: null }, { version: '' }] };
    let time = 0;
    const fetchFn = (async () => {
      counter.n++;
      return { ok: true, json: async () => payload };
    }) as unknown as typeof fetch;
    const client = new RegistryClient(store, fetchFn, TTL, () => time);

    // critically, nothing was written to the store — a persisted [null] is an
    // array, so it would survive both the empty-result guard and pruneRegistryCache
    expect(await client.providerVersions('hashicorp/aws')).toEqual([]);
    expect(store.get('provider:hashicorp/aws')).toBeUndefined();

    // so the source recovers on its own once the registry answers properly
    payload = { versions: [{ version: '5.98.0' }] };
    time = FAILURE_COOLDOWN_MS + 1;
    expect(await client.providerVersions('hashicorp/aws')).toEqual(['5.98.0']);
    expect(counter.n).toBe(2);
  });

  it('returns the fetched versions even when the store refuses to persist them', async () => {
    const counter = { n: 0 };
    const client = new RegistryClient(
      {
        get: () => undefined,
        set: () => {
          throw new Error('globalState quota exceeded');
        },
      },
      providerFetch(['5.98.0'], counter),
      TTL,
    );
    // the write failing says nothing about the request, which succeeded —
    // losing the versions here must not also arm the failure cooldown
    expect(await client.providerVersions('hashicorp/aws')).toEqual(['5.98.0']);
    expect(await client.providerVersions('hashicorp/aws')).toEqual(['5.98.0']);
    expect(counter.n).toBe(2); // uncached, so refetched — but never suppressed
  });

  it('does not refetch a failing source within the cooldown', async () => {
    const counter = { n: 0 };
    let time = 0;
    const fetchFn = (async () => {
      counter.n++;
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), fetchFn, TTL, () => time);
    expect(await client.providerVersions('hashicorp/typo')).toBeUndefined();
    expect(await client.providerVersions('hashicorp/typo')).toBeUndefined();
    expect(counter.n).toBe(1); // the 404 was not retried back to back
    time = FAILURE_COOLDOWN_MS + 1;
    await client.providerVersions('hashicorp/typo');
    expect(counter.n).toBe(2);
  });

  it('backs off further on each consecutive failure, and resets on success', async () => {
    const counter = { n: 0 };
    let time = 0;
    let ok = false;
    const fetchFn = (async () => {
      counter.n++;
      return ok
        ? { ok: true, json: async () => ({ versions: [{ version: '5.98.0' }] }) }
        : { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), fetchFn, TTL, () => time);

    // a source that can only 404 used to fire a doomed request every minute
    // for as long as the file stayed open; the first retry is still one minute
    await client.providerVersions('hashicorp/typo');
    expect(counter.n).toBe(1);

    time = FAILURE_COOLDOWN_MS + 1;
    await client.providerVersions('hashicorp/typo');
    expect(counter.n).toBe(2);

    // the second failure doubles the wait: one minute is no longer enough
    time += FAILURE_COOLDOWN_MS + 1;
    await client.providerVersions('hashicorp/typo');
    expect(counter.n).toBe(2);

    time += FAILURE_COOLDOWN_MS;
    await client.providerVersions('hashicorp/typo');
    expect(counter.n).toBe(3);

    // one success wipes the streak, so the source is back to the short cooldown
    ok = true;
    time += 4 * FAILURE_COOLDOWN_MS;
    expect(await client.providerVersions('hashicorp/typo')).toEqual(['5.98.0']);
    ok = false;
    time += TTL + 1;
    await client.providerVersions('hashicorp/typo');
    const afterReset = counter.n;
    time += FAILURE_COOLDOWN_MS + 1;
    await client.providerVersions('hashicorp/typo');
    expect(counter.n).toBe(afterReset + 1);
  });

  it('caps the backoff so a source is never abandoned for good', () => {
    expect(failureCooldownMs(1)).toBe(FAILURE_COOLDOWN_MS);
    expect(failureCooldownMs(2)).toBe(2 * FAILURE_COOLDOWN_MS);
    expect(failureCooldownMs(3)).toBe(4 * FAILURE_COOLDOWN_MS);
    expect(failureCooldownMs(50)).toBe(MAX_FAILURE_COOLDOWN_MS);
    // a huge streak must not overflow into Infinity or NaN
    expect(Number.isFinite(failureCooldownMs(100000))).toBe(true);
  });

  it('fetches module versions from the modules endpoint', async () => {
    const fetchFn = (async (url: string) => {
      expect(url).toBe(
        'https://registry.terraform.io/v1/modules/terraform-aws-modules/vpc/aws/versions',
      );
      return {
        ok: true,
        json: async () => ({
          modules: [{ versions: [{ version: '3.0.0' }, { version: '6.0.1' }] }],
        }),
      };
    }) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), fetchFn, TTL);
    expect(await client.moduleVersions('terraform-aws-modules/vpc/aws')).toEqual([
      '3.0.0',
      '6.0.1',
    ]);
  });
});

describe('pruneRegistryCache', () => {
  const NOW = 1_000_000_000_000;

  /** globalState as the extension sees it: every key, not only ours. */
  function state(entries: Record<string, unknown>) {
    const m = new Map(Object.entries(entries));
    return {
      keys: () => [...m.keys()],
      get: (k: string) => m.get(k) as CacheEntry | undefined,
      remove: (k: string) => void m.delete(k),
      left: () => [...m.keys()].sort(),
    };
  }

  it('drops entries untouched for longer than the max age', () => {
    const s = state({
      'registry:provider:hashicorp/aws': { versions: ['5.0.0'], fetchedAt: NOW - 1000 },
      'registry:provider:hashicorp/old': {
        versions: ['1.0.0'],
        fetchedAt: NOW - CACHE_MAX_AGE_MS - 1,
      },
    });
    expect(pruneRegistryCache(s.keys(), s.get, s.remove, NOW)).toBe(1);
    expect(s.left()).toEqual(['registry:provider:hashicorp/aws']);
  });

  it('never touches keys that are not ours', () => {
    const s = state({
      'tfCompanion.activeTfvars': '/r/terraform.tfvars',
      'registry:provider:hashicorp/old': {
        versions: ['1.0.0'],
        fetchedAt: NOW - CACHE_MAX_AGE_MS - 1,
      },
    });
    expect(pruneRegistryCache(s.keys(), s.get, s.remove, NOW)).toBe(1);
    expect(s.left()).toEqual(['tfCompanion.activeTfvars']);
  });

  it('drops entries no read path could interpret', () => {
    const s = state({
      'registry:provider:a': undefined,
      'registry:provider:b': { versions: ['1.0.0'] },
      // versions in a shape that would flow verbatim into version parsing
      'registry:provider:d': { versions: 'garbage', fetchedAt: NOW },
      'registry:provider:c': { versions: ['1.0.0'], fetchedAt: NOW },
    });
    expect(pruneRegistryCache(s.keys(), s.get, s.remove, NOW)).toBe(3);
    expect(s.left()).toEqual(['registry:provider:c']);
  });

  it('keeps a fresh cache intact', () => {
    const s = state({
      'registry:module:x/y/z': { versions: ['1.0.0'], fetchedAt: NOW },
    });
    expect(pruneRegistryCache(s.keys(), s.get, s.remove, NOW)).toBe(0);
    expect(s.left()).toEqual(['registry:module:x/y/z']);
  });
});

describe('an error response must not park its connection', () => {
  it('releases the unread body of a failed response', async () => {
    // undici keeps the socket out of the pool until the body is released, and
    // the !res.ok path reads none of the 404's JSON
    let cancelled = 0;
    const fetchFn = (async () => ({
      ok: false,
      body: { cancel: async () => void cancelled++ },
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), fetchFn, TTL, () => 0);

    expect(await client.providerVersions('hashicorp/typo')).toBeUndefined();
    expect(cancelled).toBe(1);
  });

  it('does not count a rejected cancel as a second failure', async () => {
    // a rejected cancel isn't a fetch failure; letting it reach the catch
    // would charge the backoff twice for one bad response
    const counter = { n: 0 };
    let time = 0;
    const fetchFn = (async () => {
      counter.n++;
      return {
        ok: false,
        body: { cancel: async () => Promise.reject(new Error('already disturbed')) },
        json: async () => ({}),
      };
    }) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), fetchFn, TTL, () => time);

    expect(await client.providerVersions('hashicorp/typo')).toBeUndefined();
    // one failure recorded → the first retry is still the base cooldown
    time = FAILURE_COOLDOWN_MS + 1;
    await client.providerVersions('hashicorp/typo');
    expect(counter.n).toBe(2);
  });

  it('tolerates a response with no body stream', async () => {
    const fetchFn = (async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const client = new RegistryClient(mapStore(), fetchFn, TTL, () => 0);
    expect(await client.providerVersions('hashicorp/typo')).toBeUndefined();
  });
});
