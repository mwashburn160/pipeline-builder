// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { makeFakeRedis } from './helpers/fake-redis.js';
import { createEnvSseTicketStore, createRedisSseTicketStore, type SseTicketStore, type SseTicketStoreConfig } from '../src/services/sse-ticket-store.js';

const stores: Array<{ stop(): void }> = [];
afterEach(() => { while (stores.length) stores.pop()!.stop(); });

const BASE: SseTicketStoreConfig = { ttlMs: 30_000, maxTotal: 100, maxPerOrg: 3 };

/** Shared contract every backend must satisfy. */
function contract(name: string, make: (cfg?: Partial<SseTicketStoreConfig>) => SseTicketStore): void {
  describe(`SSE ticket store contract (${name})`, () => {
    const build = (cfg: Partial<SseTicketStoreConfig> = {}) => {
      const s = make(cfg);
      stores.push(s);
      return s;
    };

    it('issues a ticket and redeems it exactly once', async () => {
      const store = build();
      const issued = await store.issue('org-a');
      expect(issued.ok).toBe(true);
      const ticket = issued.ok ? issued.ticket : '';
      expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
      expect(await store.consume(ticket)).toEqual({ orgId: 'org-a' });
      expect(await store.consume(ticket)).toBeNull();
    });

    it('carries the bound subject through redemption', async () => {
      const store = build();
      const issued = await store.issue('org-a', 'subject-1');
      expect(await store.consume(issued.ok ? issued.ticket : '')).toEqual({ orgId: 'org-a', subject: 'subject-1' });
    });

    it('rejects an unknown ticket', async () => {
      expect(await build().consume('never-issued')).toBeNull();
    });

    it('enforces the per-org cap on LIVE tickets', async () => {
      const store = build({ maxPerOrg: 2 });
      expect((await store.issue('org-a')).ok).toBe(true);
      expect((await store.issue('org-a')).ok).toBe(true);
      expect(await store.issue('org-a')).toEqual({ ok: false, reason: 'org' });
      expect((await store.issue('org-b')).ok).toBe(true);
    });

    it('frees a per-org slot as soon as a ticket is consumed (live count, not mints per window)', async () => {
      const store = build({ maxPerOrg: 1 });
      for (let i = 0; i < 5; i++) {
        const t = await store.issue('org-a');
        expect(t.ok).toBe(true);
        expect(await store.issue('org-a')).toEqual({ ok: false, reason: 'org' });
        if (t.ok) await store.consume(t.ticket);
      }
    });

    it('enforces the global cap on live tickets and frees it on consume', async () => {
      const store = build({ maxTotal: 2, maxPerOrg: 100 });
      const a = await store.issue('org-a');
      expect((await store.issue('org-b')).ok).toBe(true);
      expect(await store.issue('org-c')).toEqual({ ok: false, reason: 'total' });
      if (a.ok) await store.consume(a.ticket);
      expect((await store.issue('org-c')).ok).toBe(true);
    });

    it('records and reads stream ownership', async () => {
      const store = build();
      expect(await store.getOwner('subj')).toBeNull();
      await store.bindOwner('subj', 'org-a', 60_000);
      expect(await store.getOwner('subj')).toBe('org-a');
    });
  });
}

// No REDIS_URL / REDIS_SENTINELS in the test env → in-memory fallback.
contract('in-memory', (cfg) => createEnvSseTicketStore({ ...BASE, ...cfg }));
contract('redis (fake)', (cfg) => createRedisSseTicketStore(makeFakeRedis() as never, { ...BASE, ...cfg }));

describe('Redis SSE ticket store specifics', () => {
  it('expired tickets stop counting against the cap', async () => {
    jest.useFakeTimers();
    try {
      const fake = makeFakeRedis();
      const store = createRedisSseTicketStore(fake as never, { ...BASE, ttlMs: 1_000, maxPerOrg: 1 });
      expect((await store.issue('org-a')).ok).toBe(true);
      expect(await store.issue('org-a')).toEqual({ ok: false, reason: 'org' });
      jest.advanceTimersByTime(1_001);
      expect((await store.issue('org-a')).ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('namespaces tickets per channel: a ticket from one keyPrefix is not redeemable on another', async () => {
    const fake = makeFakeRedis();
    const a = createRedisSseTicketStore(fake as never, { ...BASE, keyPrefix: 'a' });
    const b = createRedisSseTicketStore(fake as never, { ...BASE, keyPrefix: 'b' });
    const t = await a.issue('org-a');
    expect(await b.consume(t.ok ? t.ticket : '')).toBeNull();
    expect(await a.consume(t.ok ? t.ticket : '')).toEqual({ orgId: 'org-a' });
  });

  it('redeems with GETDEL (single round trip — not single-use across pods otherwise)', async () => {
    const fake = makeFakeRedis();
    const store = createRedisSseTicketStore(fake as never, BASE);
    const t = await store.issue('org-a');
    fake.calls.length = 0;
    await store.consume(t.ok ? t.ticket : '');
    expect(fake.calls[0]).toBe('getdel');
    expect(fake.calls).not.toContain('get');
  });

  it('fails closed when Redis errors', async () => {
    const boom = async () => { throw new Error('down'); };
    const store = createRedisSseTicketStore({ eval: boom, getdel: boom, zrem: boom, set: boom, get: boom } as never, BASE);
    expect(await store.issue('org-a')).toEqual({ ok: false, reason: 'total' });
    expect(await store.consume('x')).toBeNull();
    await expect(store.getOwner('s')).rejects.toThrow('down');
    await expect(store.bindOwner('s', 'o', 1000)).resolves.toBeUndefined();
  });

  it('waits (bounded) for a not-yet-connected client instead of failing the first mint', async () => {
    const fake = makeFakeRedis();
    let onReady: (() => void) | undefined;
    const client = Object.assign(fake, {
      status: 'connecting',
      once: (evt: string, cb: () => void) => { if (evt === 'ready') onReady = cb; },
      off: () => undefined,
    });
    const origEval = fake.eval.bind(fake);
    client.eval = async (...args: Parameters<typeof origEval>) => {
      if (client.status !== 'ready') throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      return origEval(...args);
    };
    const store = createRedisSseTicketStore(client as never, BASE);
    const pending = store.issue('org-a');
    await new Promise((r) => setTimeout(r, 10));
    client.status = 'ready';
    onReady!();
    expect((await pending).ok).toBe(true);
  });
});

/**
 * Real-Redis check of the Lua issue script. Opt-in: set API_CORE_TEST_REDIS_URL
 * (e.g. redis://127.0.0.1:6379) to run it; skipped otherwise.
 */
const REAL_URL = process.env.API_CORE_TEST_REDIS_URL;
(REAL_URL ? describe : describe.skip)('Redis SSE ticket store (real Redis)', () => {
  const clients: Array<{ quit(): Promise<unknown> }> = [];
  afterEach(async () => { while (clients.length) await clients.pop()!.quit(); });

  async function realStore(cfg: Partial<SseTicketStoreConfig> = {}): Promise<SseTicketStore> {
    const { Redis } = await import('ioredis');
    const client = new Redis(REAL_URL!);
    clients.push(client);
    return createRedisSseTicketStore(client as never, { ...BASE, keyPrefix: `test-${Date.now()}-${Math.random()}`, ...cfg });
  }

  it('live-count caps, single-use redemption and ownership', async () => {
    const store = await realStore({ maxPerOrg: 1, maxTotal: 2 });
    const t = await store.issue('org-a', 'subj');
    expect(t.ok).toBe(true);
    expect(await store.issue('org-a')).toEqual({ ok: false, reason: 'org' });
    expect((await store.issue('org-b')).ok).toBe(true);
    expect(await store.issue('org-c')).toEqual({ ok: false, reason: 'total' });
    expect(await store.consume(t.ok ? t.ticket : '')).toEqual({ orgId: 'org-a', subject: 'subj' });
    expect(await store.consume(t.ok ? t.ticket : '')).toBeNull();
    expect((await store.issue('org-a')).ok).toBe(true);
    await store.bindOwner('subj', 'org-a', 10_000);
    expect(await store.getOwner('subj')).toBe('org-a');
  });

  it('expired tickets free their slot even while a newer ticket keeps the set alive', async () => {
    const store = await realStore({ maxPerOrg: 2, ttlMs: 300 });
    expect((await store.issue('org-a')).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect((await store.issue('org-a')).ok).toBe(true); // extends the set's TTL
    expect(await store.issue('org-a')).toEqual({ ok: false, reason: 'org' });
    await new Promise((r) => setTimeout(r, 200)); // first expired, second still live
    expect((await store.issue('org-a')).ok).toBe(true);
    expect(await store.issue('org-a')).toEqual({ ok: false, reason: 'org' });
  });
});
