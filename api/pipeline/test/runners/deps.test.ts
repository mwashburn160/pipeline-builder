// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The injectable adapters: lock, rate limiter, org feature cache, hierarchy client, the bundle. */

import { jest, describe, expect, it, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from '../helpers/mock-api-core.js';

const mockParent = jest.fn<AnyFn>();
const mockNames = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ fetchParentOrgId: mockParent, fetchOrgNames: mockNames }));

const { createHierarchyClient, createPipelineLock, createRateLimiter, orgFeatureCache, runnerDeps, runnersAvailable, setDispatchQueue, setRunnerDepsForTesting } = await import('../../src/runners/deps.js');

afterEach(() => { setRunnerDepsForTesting(null); delete process.env.RUNNER_SIGNING_KEY; });

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
});

describe('orgFeatureCache', () => {
  it('unknown → enabled; a recorded loss is shared through Redis; local fallback', async () => {
    const redis = fakeRedis();
    const a = orgFeatureCache(redis);
    expect(await a.orgEnabled('ORG1')).toBe(true);
    await a.noteOrgFeature('ORG1', false);
    const b = orgFeatureCache(redis); // another replica
    expect(await b.orgEnabled('org1')).toBe(false);
    await b.noteOrgFeature('org1', true);
    expect(await a.orgEnabled('org1')).toBe(true);
    const down = orgFeatureCache(fakeRedis(true));
    await down.noteOrgFeature('o', false);
    expect(await down.orgEnabled('o')).toBe(false);
    const none = orgFeatureCache(null);
    await none.noteOrgFeature('o', false);
    expect(await none.orgEnabled('o')).toBe(false);
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
  });
});

describe('the bundle', () => {
  it('without a key configured, runners are unavailable without building anything', () => {
    expect(runnersAvailable()).toBe(false);
  });

  it('builds the production wiring lazily; a key makes runners available', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    process.env.RUNNER_SIGNING_KEY = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(runnersAvailable()).toBe(true);
    const deps = runnerDeps();
    expect(deps.signer()).not.toBeNull();
    expect(deps.newId()).toMatch(/^[0-9a-f-]{36}$/);
    await deps.queue.enqueue('r-1'); // no queue installed: a logged no-op
    const enqueue = jest.fn(async (..._a: unknown[]) => undefined);
    setDispatchQueue({ enqueue });
    await deps.queue.enqueue('r-2', 5);
    expect(enqueue).toHaveBeenCalledWith('r-2', 5);
    await deps.sleep(1);
    expect(setRunnerDepsForTesting({ signer: () => null })!.signer()).toBeNull();
  });
});
