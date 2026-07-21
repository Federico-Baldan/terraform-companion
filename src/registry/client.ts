const BASE = 'https://registry.terraform.io/v1';

/** Defense in depth — callers already validate `source` against a
 *  registry-slug charset, but per-segment encoding stops anything slipping
 *  past from smuggling a `..` or `?query` into the path. Slashes survive,
 *  since they're structure. */
function encodePathSegments(source: string): string {
  return source.split('/').map(encodeURIComponent).join('/');
}

export interface CacheEntry {
  versions: string[];
  fetchedAt: number;
}

export interface RegistryStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, value: CacheEntry): void;
}

/** How long an untouched cache entry is kept before `pruneRegistryCache` drops it. */
export const CACHE_MAX_AGE_MS = 30 * 24 * 3600_000;

/** Store keys are written once per provider/module ever seen — without this a
 *  renamed module keeps its versions forever. A dropped entry costs one request. */
export function pruneRegistryCache(
  keys: readonly string[],
  get: (key: string) => CacheEntry | undefined,
  remove: (key: string) => void,
  now: number = Date.now(),
): number {
  let dropped = 0;
  for (const key of keys) {
    if (!key.startsWith('registry:')) continue;
    const entry = get(key);
    // a malformed entry would flow verbatim into version parsing
    if (
      !entry ||
      typeof entry.fetchedAt !== 'number' ||
      !Array.isArray(entry.versions) ||
      now - entry.fetchedAt > CACHE_MAX_AGE_MS
    ) {
      remove(key);
      dropped++;
    }
  }
  return dropped;
}

/** Only a failing source bypasses the TTL cache, so without a cooldown a typo'd
 *  provider fires one doomed request per keystroke burst. */
export const FAILURE_COOLDOWN_MS = 60_000;

export const MAX_FAILURE_COOLDOWN_MS = 30 * 60_000;

/** One minute, doubling to a thirty-minute ceiling. A hiccup and a
 *  permanently unresolvable source aren't the same failure: the first retry
 *  stays unchanged so a hiccup heals fast, and only a repeat failure decays. */
export function failureCooldownMs(consecutiveFailures: number, base = FAILURE_COOLDOWN_MS): number {
  const doublings = Math.max(0, consecutiveFailures - 1);
  return Math.min(base * 2 ** Math.min(doublings, 20), MAX_FAILURE_COOLDOWN_MS);
}

/** Bodies are untrusted, so `version` stays `unknown` until `versionStrings`. */
interface ProviderVersionsResponse {
  versions?: { version?: unknown }[];
}

interface ModuleVersionsResponse {
  modules?: { versions?: { version?: unknown }[] }[];
}

/** Filtering here turns a malformed body into the empty result the failure
 *  path already handles. Unfiltered, `[undefined]` has length 1 — it passes
 *  the empty-result guard, persists as `[null]`, and survives pruning. */
function versionStrings(entries: { version?: unknown }[] | undefined): string[] {
  return (entries ?? [])
    .map((v) => v.version)
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/** Registry API client. Offline-first: any failure returns the stale cache
 *  or undefined — it never throws and never surfaces an error. */
export class RegistryClient {
  private inflight = new Map<string, Promise<string[] | undefined>>();
  /** key → last failure time and consecutive count, for the backoff */
  private failures = new Map<string, { at: number; count: number }>();

  constructor(
    private store: RegistryStore,
    private fetchFn: typeof fetch,
    /** Read per request, or the setting would need a window reload to apply. */
    private ttlMs: number | (() => number),
    private now: () => number = Date.now,
    private timeoutMs = 8000,
    private failureCooldownMs = FAILURE_COOLDOWN_MS,
  ) {}

  private ttl(): number {
    return typeof this.ttlMs === 'function' ? this.ttlMs() : this.ttlMs;
  }

  /** Best-effort, deliberately outside the request's try/catch — a store
   *  that throws must not look like a failed fetch and arm the cooldown. */
  private persist(key: string, versions: string[]): void {
    try {
      this.store.set(key, { versions, fetchedAt: this.now() });
    } catch {
      // not cached; the next call simply refetches
    }
  }

  providerVersions(source: string): Promise<string[] | undefined> {
    const full = source.includes('/') ? source : `hashicorp/${source}`;
    return this.cached<ProviderVersionsResponse>(
      `provider:${full}`,
      `${BASE}/providers/${encodePathSegments(full)}/versions`,
      (json) => versionStrings(json.versions),
    );
  }

  moduleVersions(source: string): Promise<string[] | undefined> {
    return this.cached<ModuleVersionsResponse>(
      `module:${source}`,
      `${BASE}/modules/${encodePathSegments(source)}/versions`,
      (json) => versionStrings(json.modules?.[0]?.versions),
    );
  }

  private cached<T>(
    key: string,
    url: string,
    extract: (json: T) => string[],
  ): Promise<string[] | undefined> {
    const entry = this.store.get(key);
    if (entry && this.now() - entry.fetchedAt < this.ttl()) {
      return Promise.resolve(entry.versions);
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const failed = this.failures.get(key);
    if (
      failed !== undefined &&
      this.now() - failed.at < failureCooldownMs(failed.count, this.failureCooldownMs)
    ) {
      return Promise.resolve(entry?.versions);
    }

    const fail = () => {
      const previous = this.failures.get(key)?.count ?? 0;
      this.failures.set(key, { at: this.now(), count: previous + 1 });
    };
    const promise = (async (): Promise<string[] | undefined> => {
      try {
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) {
          fail();
          // undici keeps the socket out of the pool until the body is released,
          // and nothing here reads the 404's JSON. Not awaited; rejection is
          // swallowed — it's not a fetch failure and must not count twice
          void res.body?.cancel().catch(() => undefined);
          return entry?.versions;
        }
        const versions = extract((await res.json()) as T);
        // Caching an empty result would blank the lens for the whole TTL even
        // after the registry recovers; the cooldown paces the retries instead.
        if (versions.length === 0) {
          fail();
          return entry?.versions ?? versions;
        }
        this.failures.delete(key);
        this.persist(key, versions);
        return versions;
      } catch {
        fail();
        return entry?.versions;
      }
    })();
    this.inflight.set(key, promise);
    // cleared after registration, not inside the body — a synchronously
    // throwing fetchFn would run its finally before the set() above, pinning
    // the settled promise forever. Identity check stops a slow cleanup
    // evicting a newer one
    void promise.finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    return promise;
  }
}
