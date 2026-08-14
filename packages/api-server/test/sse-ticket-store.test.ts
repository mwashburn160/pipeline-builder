// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { createMemoryTicketStore, createRedisTicketStore } = await import('../src/http/sse-ticket-store.js');

/** In-memory ioredis stand-in: string KV with EX + a couple of ZSET ops. */
function fakeRedis() {
  const kv = new Map<string, { value: string; expiresAt: number }>();
  const zsets = new Map<string, Map<string, number>>();
  const zset = (k: string) => { let z = zsets.get(k); if (!z) { z = new Map(); zsets.set(k, z); } return z; };
  const live = (k: string) => { const e = kv.get(k); if (!e) return null; if (Date.now() > e.expiresAt) { kv.delete(k); return null; } return e.value; };
  return {
    async get(k: string) { return live(k); },
    async set(k: string, v: string, ..._args: (string | number)[]) { kv.set(k, { value: v, expiresAt: Date.now() + 3_600_000 }); return 'OK'; },
    async del(...keys: string[]) { let n = 0; for (const k of keys) if (kv.delete(k)) n++; return n; },
    async zadd(k: string, score: number, member: string) { zset(k).set(member, score); return 1; },
    async zrem(k: string, ...members: string[]) { let n = 0; for (const m of members) if (zset(k).delete(m)) n++; return n; },
    async zcard(k: string) { return zset(k).size; },
    async zremrangebyscore(k: string, min: number, max: number) {
      let n = 0;
      for (const [m, s] of zset(k)) if (s >= min && s <= max) { zset(k).delete(m); n++; }
      return n;
    },
    async expire() { return 1; },
  };
}

describe('createMemoryTicketStore', () => {
  it('put/consume is single-use and caps count by org', async () => {
    const store = createMemoryTicketStore();
    await store.put('t1', { orgId: 'org-a', requestId: 'aaaa' }, 60_000);
    await store.put('t2', { orgId: 'org-a', requestId: 'bbbb' }, 60_000);
    expect(await store.countForOrg('org-a')).toBe(2);
    expect(await store.total()).toBe(2);

    expect(await store.consume('t1')).toEqual({ orgId: 'org-a', requestId: 'aaaa' });
    // Single-use: a replay is gone.
    expect(await store.consume('t1')).toBeNull();
    expect(await store.countForOrg('org-a')).toBe(1);
  });

  it('binds and reads stream ownership; unbound → null', async () => {
    const store = createMemoryTicketStore();
    expect(await store.getStreamOwner('subj')).toBeNull();
    await store.bindStreamOwner('subj', 'org-a', 60_000);
    expect(await store.getStreamOwner('subj')).toBe('org-a');
  });
});

describe('createRedisTicketStore', () => {
  it('put/consume round-trips and clears the cap counters', async () => {
    const store = createRedisTicketStore(fakeRedis());
    await store.put('t1', { orgId: 'org-a', requestId: 'aaaa' }, 60_000);
    expect(await store.countForOrg('org-a')).toBe(1);
    expect(await store.total()).toBe(1);

    expect(await store.consume('t1')).toEqual({ orgId: 'org-a', requestId: 'aaaa' });
    // Consumed → gone from both the key space and the ZSET counters.
    expect(await store.consume('t1')).toBeNull();
    expect(await store.countForOrg('org-a')).toBe(0);
    expect(await store.total()).toBe(0);
  });

  it('records stream ownership', async () => {
    const store = createRedisTicketStore(fakeRedis());
    expect(await store.getStreamOwner('subj')).toBeNull();
    await store.bindStreamOwner('subj', 'org-b', 60_000);
    expect(await store.getStreamOwner('subj')).toBe('org-b');
  });

  it('is fail-safe: a throwing redis yields null/0 rather than throwing', async () => {
    const boom = new Proxy({}, { get: () => async () => { throw new Error('down'); } }) as any;
    const store = createRedisTicketStore(boom);
    await expect(store.put('t', { orgId: 'o', requestId: 'r' }, 1000)).resolves.toBeUndefined();
    await expect(store.consume('t')).resolves.toBeNull();
    await expect(store.countForOrg('o')).resolves.toBe(0);
    await expect(store.total()).resolves.toBe(0);
    await expect(store.getStreamOwner('r')).resolves.toBeNull();
  });
});
