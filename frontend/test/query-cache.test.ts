// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared read cache. These pin the four behaviours the layer exists for —
 * de-duplication, a stale window, invalidation on mutation, and a hard drop at
 * the tenant boundary — plus the abort accounting that makes cancellation real
 * rather than "ignore the answer when it arrives".
 */

import { describe, it, expect } from '@jest/globals';
import {
  clearQueryCache,
  invalidateQueries,
  isQueryFresh,
  peekQuery,
  queryCacheStats,
  queryFetch,
  runQuery,
  subscribeQueries,
} from '../src/lib/query-cache';

/** A fetcher that never settles — stands in for a request still on the wire. */
const pendingForever = () => new Promise<string>(() => { /* never settles */ });

describe('queryFetch — de-duplication', () => {
  it('serves N concurrent callers of the same key from ONE request', async () => {
    let calls = 0;
    const fetcher = () => { calls += 1; return Promise.resolve('value'); };

    const results = await Promise.all([
      queryFetch('k', fetcher),
      queryFetch('k', fetcher),
      queryFetch('k', fetcher),
    ]);

    expect(calls).toBe(1);
    expect(results).toEqual(['value', 'value', 'value']);
  });

  it('keeps DIFFERENT keys apart', async () => {
    let calls = 0;
    const fetcher = (v: string) => () => { calls += 1; return Promise.resolve(v); };
    const [a, b] = await Promise.all([queryFetch('a', fetcher('A')), queryFetch('b', fetcher('B'))]);
    expect(calls).toBe(2);
    expect([a, b]).toEqual(['A', 'B']);
  });

  it('does not join an already-aborted flight (it could never resolve)', async () => {
    const first = new AbortController();
    const joined = queryFetch('k', pendingForever, { signal: first.signal });
    // Sole subscriber leaves → the shared request is aborted.
    first.abort();
    await expect(joined).rejects.toThrow();

    // A newcomer must start a fresh request rather than inherit the dead one.
    const fresh = await queryFetch('k', () => Promise.resolve('fresh'));
    expect(fresh).toBe('fresh');
  });
});

describe('queryFetch — stale window', () => {
  it('serves a fresh hit from memory with no network call', async () => {
    let calls = 0;
    const fetcher = () => { calls += 1; return Promise.resolve(1); };
    await queryFetch('k', fetcher, { staleMs: 10_000 });
    await queryFetch('k', fetcher, { staleMs: 10_000 });
    expect(calls).toBe(1);
    expect(isQueryFresh('k', 10_000)).toBe(true);
    expect(peekQuery<number>('k')).toBe(1);
  });

  it('re-fetches once the entry is older than the window', async () => {
    let calls = 0;
    const fetcher = () => { calls += 1; return Promise.resolve(calls); };
    await queryFetch('k', fetcher, { staleMs: 10_000 });
    // A zero-length window makes every entry stale on the next read.
    await queryFetch('k', fetcher, { staleMs: 0 });
    expect(calls).toBe(2);
  });

  it('`force` goes to the network even while the entry is fresh', async () => {
    let calls = 0;
    const fetcher = () => { calls += 1; return Promise.resolve(calls); };
    await queryFetch('k', fetcher, { staleMs: 10_000 });
    const second = await queryFetch('k', fetcher, { staleMs: 10_000, force: true });
    expect(calls).toBe(2);
    expect(second).toBe(2);
  });
});

describe('invalidateQueries — on mutation', () => {
  it('drops the matching prefix, keeps everything else, and notifies', async () => {
    await queryFetch('pipelines?limit=1', () => Promise.resolve('p'));
    await queryFetch('org-members/o1?', () => Promise.resolve('m'));
    let woke = 0;
    const unsubscribe = subscribeQueries(() => { woke += 1; });

    invalidateQueries('pipelines?');

    expect(peekQuery('pipelines?limit=1')).toBeUndefined();
    expect(peekQuery('org-members/o1?')).toBe('m');
    expect(woke).toBe(1);
    unsubscribe();
  });

  it('a read after invalidation actually re-fetches', async () => {
    let calls = 0;
    const fetcher = () => { calls += 1; return Promise.resolve(calls); };
    await queryFetch('pipelines?', fetcher, { staleMs: 10_000 });
    invalidateQueries('pipelines?');
    const again = await queryFetch('pipelines?', fetcher, { staleMs: 10_000 });
    expect(calls).toBe(2);
    expect(again).toBe(2);
  });

  it('stops notifying an unsubscribed listener', () => {
    let woke = 0;
    subscribeQueries(() => { woke += 1; })();
    invalidateQueries('anything');
    expect(woke).toBe(0);
  });
});

describe('clearQueryCache — the tenant boundary', () => {
  it('empties every entry on an org switch / sign-out', async () => {
    await queryFetch('a', () => Promise.resolve(1));
    await queryFetch('b', () => Promise.resolve(2));
    expect(queryCacheStats().entries).toBe(2);

    clearQueryCache();

    expect(queryCacheStats().entries).toBe(0);
    expect(peekQuery('a')).toBeUndefined();
    expect(peekQuery('b')).toBeUndefined();
  });

  it('a response issued under the PREVIOUS org can never fill the next org\'s cache', async () => {
    let resolveIt!: (v: string) => void;
    const inflight = queryFetch('k', () => new Promise<string>((res) => { resolveIt = res; }));

    // The user switches org while that request is still on the wire.
    clearQueryCache();
    // …and only now does org A's answer come back. The caller that asked for it
    // still receives it (nothing is hidden), but it must not be WRITTEN into the
    // cache the next tenant is about to read.
    resolveIt('org-A-private-data');
    await inflight.catch(() => { /* the clear may have aborted it first */ });

    expect(peekQuery('k')).toBeUndefined();
    expect(queryCacheStats().entries).toBe(0);
  });

  it('aborts the requests it abandons', async () => {
    const seen: AbortSignal[] = [];
    const pending = queryFetch('k', (signal) => {
      seen.push(signal);
      return new Promise<string>(() => { /* never settles */ });
    });
    pending.catch(() => { /* expected */ });

    expect(seen[0].aborted).toBe(false);
    clearQueryCache();
    expect(seen[0].aborted).toBe(true);
  });
});

describe('queryFetch — abort accounting', () => {
  it('keeps the shared request alive while ANY subscriber still wants it', async () => {
    const seen: AbortSignal[] = [];
    let resolveIt!: (v: string) => void;
    const run = (signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<string>((res) => { resolveIt = res; });
    };

    const leaving = new AbortController();
    const staying = new AbortController();
    const abandoned = queryFetch('k', run, { signal: leaving.signal });
    const kept = queryFetch('k', run, { signal: staying.signal });
    abandoned.catch(() => { /* expected */ });

    leaving.abort();
    expect(seen[0].aborted).toBe(false); // the other subscriber is still waiting

    resolveIt('value');
    await expect(kept).resolves.toBe('value');
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts on the wire once the LAST subscriber leaves', async () => {
    const seen: AbortSignal[] = [];
    const run = (signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<string>(() => { /* never settles */ });
    };
    const a = new AbortController();
    const b = new AbortController();
    queryFetch('k', run, { signal: a.signal }).catch(() => {});
    queryFetch('k', run, { signal: b.signal }).catch(() => {});

    a.abort();
    expect(seen[0].aborted).toBe(false);
    b.abort();
    expect(seen[0].aborted).toBe(true);
  });

  it('rejects immediately for a caller whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(
      queryFetch('k', () => { called = true; return Promise.resolve(1); }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(called).toBe(false);
  });

  it('does not cache a failed read', async () => {
    await expect(queryFetch('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(peekQuery('k')).toBeUndefined();
    expect(queryCacheStats().inflight).toBe(0);
  });
});

describe('runQuery', () => {
  it('uses the descriptor\'s own freshness window', async () => {
    let calls = 0;
    const query = { key: 'q', run: () => { calls += 1; return Promise.resolve(calls); }, staleMs: 10_000 };
    await runQuery(query);
    await runQuery(query);
    expect(calls).toBe(1);
  });

  it('an explicit staleMs overrides the descriptor', async () => {
    let calls = 0;
    const query = { key: 'q', run: () => { calls += 1; return Promise.resolve(calls); }, staleMs: 10_000 };
    await runQuery(query);
    await runQuery(query, { staleMs: 0 });
    expect(calls).toBe(2);
  });
});
