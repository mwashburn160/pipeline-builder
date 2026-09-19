// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The app's one shared read cache.
 *
 * Deliberately ~150 lines in-repo rather than a query library: the whole of what
 * this codebase needs from one is request de-duplication, a short stale window,
 * invalidation on mutation and a hard drop at the tenant boundary. `swr` was
 * removed from this repo once already; re-adding a dependency (and its
 * revalidation model, focus/reconnect policies and provider tree) to get four
 * behaviours is not a trade worth making.
 *
 * What it guarantees:
 *  - **Dedupe** — N components asking for the same key while a request is in
 *    flight share that one request, and each gets its own abort handle.
 *  - **Stale window** — a hit younger than `staleMs` resolves from memory with
 *    no network at all, so a back-navigation repaints instead of re-fetching.
 *  - **Invalidation** — `invalidateQueries(prefix)` drops matching entries and
 *    wakes every mounted `useQuery` so it re-reads after a mutation.
 *  - **Tenant/session drop** — `clearQueryCache()` empties everything AND bumps
 *    a generation counter, so a response already in flight under the previous
 *    org can never land in the next org's cache.
 *
 * It caches READS only. Nothing here retries, writes, or persists to storage.
 */

import { abortError } from './abort';

/** Default freshness window. Long enough to cover a navigate-and-come-back,
 *  short enough that a stale list is never what somebody acts on. */
export const DEFAULT_STALE_MS = 30_000;

interface CacheEntry {
  value: unknown;
  /** Epoch ms of the fill. */
  at: number;
}

interface Inflight {
  promise: Promise<unknown>;
  /** Aborted only once EVERY subscriber has gone away (see `attach`). */
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

const entries = new Map<string, CacheEntry>();
const inflight = new Map<string, Inflight>();
const listeners = new Set<() => void>();
/**
 * Per-key invalidation counter.
 *
 * Mounted readers wake on a key's OWN counter rather than a single global one,
 * so invalidating pipelines after a delete doesn't re-run the effects of every
 * subscription/plan/member reader in the tree — each of which would tear down
 * and rebuild its abort handle for data nobody touched.
 */
const keyEpochs = new Map<string, number>();

/**
 * Bumped by {@link clearQueryCache}. A request that started under an older
 * generation refuses to write its result — the identity it was issued under is
 * gone (org switch, sign-out), so its answer belongs to nobody.
 */
let cacheGeneration = 0;

function notify(): void {
  listeners.forEach((l) => {
    try { l(); } catch { /* a listener must never break the cache */ }
  });
}

/**
 * Mark `key` as needing a re-read.
 *
 * Applied to in-flight keys as well as cached ones: a request abandoned by
 * {@link clearQueryCache} rejects with an abort its reader deliberately ignores,
 * so without a bump that reader would sit on `loading` forever.
 */
function bumpKey(key: string): void {
  keyEpochs.set(key, (keyEpochs.get(key) ?? 0) + 1);
}

/** Subscribe to invalidations (for `useSyncExternalStore`). */
export function subscribeQueries(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** How many times `key` has been invalidated. Changes only for keys actually
 *  affected, so a reader re-runs only when ITS data was dropped. */
export function getKeyEpoch(key: string | null): number {
  return key === null ? 0 : keyEpochs.get(key) ?? 0;
}

/** The cached value for `key`, regardless of age, or `undefined`. Used to seed
 *  a hook synchronously so a revisit paints before the revalidation lands. */
export function peekQuery<T>(key: string): T | undefined {
  return entries.get(key)?.value as T | undefined;
}

/** True when `key` has a value inside its freshness window. */
export function isQueryFresh(key: string, staleMs = DEFAULT_STALE_MS): boolean {
  const hit = entries.get(key);
  return !!hit && Date.now() - hit.at < staleMs;
}

/**
 * Join an in-flight request.
 *
 * The shared request outlives any individual subscriber: it is aborted only when
 * the LAST one leaves. Each subscriber's own promise rejects the instant its own
 * signal fires, so an unmounted component never waits on a request its siblings
 * still want.
 */
function attach<T>(flight: Inflight, signal?: AbortSignal): Promise<T> {
  flight.waiters += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled) flight.controller.abort(abortError());
  };

  if (!signal) {
    flight.promise.then(release, release);
    return flight.promise as Promise<T>;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { release(); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); release(); resolve(value as T); },
      (err) => { signal.removeEventListener('abort', onAbort); release(); reject(err); },
    );
  });
}

/**
 * A named read: the cache key, how to run it, and how long its answer stays
 * fresh. Declaring the three together is what lets the SAME definition be used
 * imperatively ({@link runQuery}) and as a hook (`useQuery`) without either side
 * re-deriving a key or a freshness window that could drift from the other's.
 */
export interface Query<T> {
  key: string;
  run: (signal: AbortSignal) => Promise<T>;
  staleMs?: number;
}

export interface QueryFetchOptions {
  /** Freshness window for a cache hit. Defaults to {@link DEFAULT_STALE_MS}. */
  staleMs?: number;
  /** The caller's own cancellation handle. */
  signal?: AbortSignal;
  /** Skip the freshness check and go to the network (still de-duplicated). */
  force?: boolean;
}

/**
 * Read `key`, fetching it at most once per key per in-flight window.
 *
 * `fetcher` receives the SHARED abort signal — pass it straight to the API
 * client so a request nobody is waiting for any more is actually cancelled on
 * the wire, not merely ignored on arrival.
 */
export function queryFetch<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: QueryFetchOptions = {},
): Promise<T> {
  const { staleMs = DEFAULT_STALE_MS, signal, force = false } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  if (!force && isQueryFresh(key, staleMs)) {
    return Promise.resolve(entries.get(key)!.value as T);
  }

  let flight = inflight.get(key);
  // An already-aborted flight (its last subscriber left, or the cache was
  // cleared) can never resolve, so joining it would hand this caller the abort
  // instead of the data. Start a fresh one; the dead flight's own `finally`
  // only deletes the map slot if it still owns it.
  if (flight?.controller.signal.aborted) flight = undefined;
  if (!flight) {
    const controller = new AbortController();
    // Captured, not read back off the flight: the closure below compares it to
    // the live counter to decide whether its answer still belongs to anybody.
    const generation = cacheGeneration;
    const created: Inflight = {
      controller,
      waiters: 0,
      settled: false,
      promise: undefined as unknown as Promise<unknown>,
    };
    created.promise = (async () => {
      try {
        const value = await fetcher(controller.signal);
        // Only publish under the identity the request was issued for.
        // No `notify()` here on purpose: every caller already holds its own
        // promise for this value, and waking the whole tree on each fill would
        // re-run in-flight readers' effects (aborting their requests) for data
        // they never asked about. Listeners exist for INVALIDATION only.
        if (generation === cacheGeneration) {
          entries.set(key, { value, at: Date.now() });
        }
        return value;
      } finally {
        created.settled = true;
        if (inflight.get(key) === created) inflight.delete(key);
      }
    })();
    inflight.set(key, created);
    flight = created;
  }
  return attach<T>(flight, signal);
}

/**
 * Run a {@link Query} imperatively — for event handlers and multi-request page
 * loads, where there is no hook to hang the read on.
 */
export function runQuery<T>(
  query: Query<T>,
  options: Omit<QueryFetchOptions, 'staleMs'> & { staleMs?: number } = {},
): Promise<T> {
  const { staleMs = query.staleMs, ...rest } = options;
  return queryFetch(query.key, query.run, staleMs === undefined ? rest : { ...rest, staleMs });
}

/**
 * Drop every cached entry whose key starts with `prefix` (all of them when
 * omitted) and wake mounted readers.
 *
 * In-flight requests are left alone: they were issued under the current
 * identity, so their answer is still this tenant's. They simply refill a key
 * that now has a fresh mounted reader waiting for it.
 */
export function invalidateQueries(prefix?: string): void {
  const matches = (key: string) => prefix === undefined || key.startsWith(prefix);
  for (const key of [...entries.keys()]) {
    if (matches(key)) { entries.delete(key); bumpKey(key); }
  }
  // A key with no entry yet but a request on the wire still has a reader
  // waiting on data the mutation just invalidated.
  for (const key of inflight.keys()) {
    if (matches(key) && !entries.has(key)) bumpKey(key);
  }
  notify();
}

/**
 * Hard reset at an identity boundary — org switch, sign-out, session expiry.
 *
 * Unlike {@link invalidateQueries} this also abandons in-flight requests: their
 * generation no longer matches, so their results are discarded rather than
 * written into the next tenant's cache. The requests themselves are aborted,
 * because nothing is going to read them.
 */
export function clearQueryCache(): void {
  cacheGeneration += 1;
  for (const key of entries.keys()) bumpKey(key);
  entries.clear();
  for (const [key, flight] of inflight) {
    bumpKey(key);
    if (!flight.settled) flight.controller.abort(abortError());
  }
  inflight.clear();
  notify();
}

/** Test seam: how many keys are cached / in flight right now. */
export function queryCacheStats(): { entries: number; inflight: number; generation: number } {
  return { entries: entries.size, inflight: inflight.size, generation: cacheGeneration };
}
