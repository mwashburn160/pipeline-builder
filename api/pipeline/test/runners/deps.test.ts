// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The injectable adapters: lock, rate limiter, hierarchy client, availability, the bundle. */

import { jest, describe, expect, it, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from '../helpers/mock-api-core.js';

const mockParent = jest.fn<AnyFn>();
const mockNames = jest.fn<AnyFn>();
const mockDescendants = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ fetchParentOrgId: mockParent, fetchOrgNames: mockNames, fetchOrgDescendants: mockDescendants }));

const { createHierarchyClient, createKeyDeps, createPipelineLock, createRateLimiter, resyncKeyCaches, runnerDeps, runnersReady, setDispatchQueue, setRunnerDepsForTesting } = await import('../../src/runners/deps.js');
const { keyedDeps } = await import('../helpers/key-fakes.js');
const { setKeyInvalidationBusForTesting } = await import('../../src/runners/key-invalidation.js');

afterEach(() => { setRunnerDepsForTesting(null); });

function fakeRedis(fail = false) {
  const kv = new Map<string, string>();
  return {
    kv,
    set: jest.fn(async (k: string, v: string, ...args: (string | number)[]) => {
      if (fail) throw new Error('redis down');
      if (args.includes('NX') && kv.has(k)) return null;
      kv.set(k, v); return 'OK';
    }),
    get: jest.fn(async (k: string) => { if (fail) throw new Error('redis down'); return kv.get(k) ?? null; }),
    eval: jest.fn(async (_s: string, _n: number, k: string, a: string | number) => {
      if (fail) throw new Error('redis down');
      if (typeof a === 'string' && kv.get(k) === a) { kv.delete(k); return 1; }
      const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n;
    }),
  };
}

describe('createPipelineLock', () => {
  it('Redis SET NX: one holder per pipeline; owner-only release', async () => {
    const redis = fakeRedis();
    const lock = createPipelineLock(redis);
    const t = await lock.acquire('p', 1000);
    expect(t).toEqual(expect.any(String));
    expect(await lock.acquire('p', 1000)).toBeNull();
    await lock.release('p', t!);
    expect(await lock.acquire('p', 1000)).toEqual(expect.any(String));
  });

  it('in-process without Redis (and when Redis errors), with TTL expiry', async () => {
    let now = 0;
    const lock = createPipelineLock(fakeRedis(true), () => now);
    const t = await lock.acquire('p', 1000);
    expect(await lock.acquire('p', 1000)).toBeNull();
    now = 1001;
    expect(await lock.acquire('p', 1000)).toEqual(expect.any(String));
    await lock.release('p', t!);
    const local = createPipelineLock(null, () => now);
    const t2 = await local.acquire('q', 10);
    await local.release('q', t2!);
    expect(await local.acquire('q', 10)).toEqual(expect.any(String));
  });
});

describe('createRateLimiter', () => {
  it('fixed window in Redis; in-process without; fails open on a Redis error', async () => {
    const lim = createRateLimiter(fakeRedis());
    expect(await lim.hit('k', 2, 60_000)).toBe(true);
    expect(await lim.hit('k', 2, 60_000)).toBe(true);
    expect(await lim.hit('k', 2, 60_000)).toBe(false);
    expect(await createRateLimiter(fakeRedis(true)).hit('k', 0, 1)).toBe(true);
    let now = 0;
    const local = createRateLimiter(null, () => now);
    expect(await local.hit('k', 1, 1000)).toBe(true);
    expect(await local.hit('k', 1, 1000)).toBe(false);
    now = 1000;
    expect(await local.hit('k', 1, 1000)).toBe(true);
  });

  it('in-process windows that expired are dropped (the public JWKS route keys it by caller-chosen runner ids)', async () => {
    let now = 0;
    const local = createRateLimiter(null, () => now);
    for (let i = 0; i < 5000; i++) await local.hit(`jwks-runner:${i}`, 10, 60_000);
    expect(local.localSize()).toBe(5000);
    now = 60_000;
    for (let i = 0; i < 2000; i++) await local.hit(`jwks-runner:new-${i}`, 10, 60_000);
    // The 5000 expired windows are gone; only live ones are held.
    expect(local.localSize()).toBe(2000);
    expect(await local.hit('jwks-runner:new-0', 1, 60_000)).toBe(false);
  });
});

describe('createHierarchyClient', () => {
  it('walks parents nearest first, cycle- and failure-safe; names fail soft', async () => {
    mockParent.mockImplementation(async (id: string) => ({ b: 'c', c: 'a' } as Record<string, string>)[id]);
    const h = createHierarchyClient();
    expect(await h.ancestors('a', 'b')).toEqual(['b', 'c']);
    mockParent.mockReset();
    mockParent.mockResolvedValueOnce('p1').mockRejectedValueOnce(new Error('down'));
    expect(await h.ancestors('x')).toEqual(['p1']);
    mockNames.mockResolvedValueOnce({ p1: 'Parent' }).mockRejectedValueOnce(new Error('down'));
    expect(await h.names(['p1'])).toEqual({ p1: 'Parent' });
    expect(await h.names(['p1'])).toEqual({});
    // Descendants: without the org itself; none / a failed lookup is [].
    mockDescendants.mockResolvedValueOnce(['P', 't1', 't2']).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));
    expect(await h.descendants('p')).toEqual(['t1', 't2']);
    expect(await h.descendants('p')).toEqual([]);
    expect(await h.descendants('p')).toEqual([]);
  });

  it('strict ancestry (the signing-key rules) throws on a failed lookup instead of returning a shorter chain; a 404 is "no parent"', async () => {
    const h = createHierarchyClient();
    mockParent.mockReset();
    mockParent.mockResolvedValueOnce('p1').mockRejectedValueOnce(new Error('parent-org lookup failed for p1: HTTP 503'));
    await expect(h.ancestors('x', undefined, { strict: true })).rejects.toThrow('HTTP 503');
    expect(mockParent).toHaveBeenCalledWith('x', { throwOnHttpError: true });
    mockParent.mockReset();
    mockParent.mockResolvedValueOnce('p1').mockRejectedValueOnce(new Error('parent-org lookup failed for p1: HTTP 404'));
    expect(await h.ancestors('x', undefined, { strict: true })).toEqual(['p1']);
  });
});

describe('the bundle', () => {
  it('builds the production wiring lazily (no signing key anywhere in it)', async () => {
    const deps = runnerDeps();
    expect(deps).not.toHaveProperty('signer');
    expect(typeof deps.signerFor).toBe('function');
    expect(deps.newId()).toMatch(/^[0-9a-f-]{36}$/);
    await deps.queue.enqueue('r-1'); // no queue installed: a logged no-op
    const enqueue = jest.fn(async (..._a: unknown[]) => undefined);
    setDispatchQueue({ enqueue });
    await deps.queue.enqueue('r-2', 5);
    expect(enqueue).toHaveBeenCalledWith('r-2', 5);
    await deps.sleep(1);
  });

  it('a published key change drops THIS replica\'s caches at once, before (or without) its own pub/sub echo', () => {
    const sent: unknown[] = [];
    setKeyInvalidationBusForTesting({ publish: (m) => { sent.push(m); }, subscribe: () => undefined });
    try {
      const deps = runnerDeps();
      deps.keyCaches.jwks.set('r-1', { ownerOrgId: 'org-a', body: { keys: [] }, at: 0 });
      deps.keyCaches.jwks.set('r-2', { ownerOrgId: 'org-b', body: { keys: [] }, at: 0 });
      deps.keyCaches.pause = { paused: false, at: 0 };
      deps.publishKeyInvalidation({ kind: 'keys', orgIds: ['ORG-A'] });
      expect([...deps.keyCaches.jwks.keys()]).toEqual(['r-2']);
      deps.publishKeyInvalidation({ kind: 'pause', paused: true });
      expect(deps.keyCaches.pause).toBeNull();
      expect(sent).toEqual([{ kind: 'keys', orgIds: ['ORG-A'] }, { kind: 'pause', paused: true }]);
    } finally {
      setKeyInvalidationBusForTesting(undefined);
    }
  });
});

describe('runnersAvailable: encryption, tables, pause', () => {
  function bundle(ready: boolean) {
    const d = keyedDeps();
    Object.assign(d, createKeyDeps(() => d, { encryptionReady: () => ready }));
    return d;
  }

  it('no secret encryption → encryption_not_configured; no tables → tables_missing; paused → paused; else available', async () => {
    expect(await bundle(false).runnersAvailable()).toEqual({ available: false, reason: 'encryption_not_configured' });
    const noTables = bundle(true);
    noTables.keyStore.tablesPresent = async () => false;
    expect(await noTables.runnersAvailable()).toEqual({ available: false, reason: 'tables_missing' });
    const d = bundle(true);
    expect(await d.runnersAvailable()).toEqual({ available: true });
    setRunnerDepsForTesting(d);
    expect(await runnersReady()).toBe(true);
    await d.keyStore.setPause({ paused: true, by: 'op', reason: null, at: new Date() });
    expect(await d.runnersAvailable()).toEqual({ available: true }); // cached for 60 s
    resyncKeyCaches(d);
    expect(await d.runnersAvailable()).toEqual({ available: false, reason: 'paused' });
    expect(await runnersReady()).toBe(false);
  });

  it('an unreadable pause row keeps the last answer, or fails closed (paused) with none', async () => {
    const d = bundle(true);
    d.keyStore.getPause = async () => { throw new Error('db down'); };
    expect(await d.deliveriesPaused()).toBe(true);
    const e = bundle(true);
    expect(await e.deliveriesPaused()).toBe(false);
    e.keyStore.getPause = async () => { throw new Error('db down'); };
    e.clock.t += 61_000;
    expect(await e.deliveriesPaused()).toBe(false);
  });
});
