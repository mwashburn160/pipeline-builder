// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { createRedisAuditSpool } from '../src/services/audit-spool.js';
import type { RemoteAuditEvent } from '../src/services/remote-audit-client.js';

/** In-memory stand-in for the ioredis LIST surface the spool uses. Keyed by
 *  list name so the main buffer and the `:inflight` in-progress list coexist. */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const get = (k: string) => { let l = lists.get(k); if (!l) { l = []; lists.set(k, l); } return l; };
  return {
    async rpush(k: string, ...v: string[]) { const l = get(k); l.push(...v); return l.length; },
    async lpush(k: string, ...v: string[]) { const l = get(k); l.unshift(...[...v].reverse()); return l.length; },
    async lpop(k: string, count: number) { const out = get(k).splice(0, count); return out.length ? out : null; },
    async ltrim(k: string, start: number, stop: number) { lists.set(k, get(k).slice(start, stop === -1 ? undefined : stop + 1)); },
    async llen(k: string) { return get(k).length; },
    async lmove(src: string, dst: string, from: 'LEFT' | 'RIGHT', to: 'LEFT' | 'RIGHT') {
      const s = get(src);
      const val = from === 'LEFT' ? s.shift() : s.pop();
      if (val === undefined) return null;
      const d = get(dst);
      if (to === 'LEFT') d.unshift(val); else d.push(val);
      return val;
    },
    async lrem(k: string, _count: number, value: string) {
      const l = get(k); const idx = l.indexOf(value);
      if (idx >= 0) { l.splice(idx, 1); return 1; }
      return 0;
    },
    _list: (k = 'audit:spool') => get(k),
  };
}

const evt = (action: string): RemoteAuditEvent => ({ action: action as RemoteAuditEvent['action'], actorId: 'u1' });

describe('createRedisAuditSpool', () => {
  it('enqueue/take round-trips entries FIFO and removes them', async () => {
    const spool = createRedisAuditSpool(fakeRedis());
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'pipeline' });
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'pipeline' });
    expect(await spool.depth()).toBe(2);

    const batch = await spool.take(10);
    expect(batch.map((e) => e.event.action)).toEqual(['pipeline.create', 'pipeline.update']);
    expect(await spool.depth()).toBe(0);
    expect(await spool.take(10)).toEqual([]);
  });

  it('bounds the buffer, dropping the OLDEST on overflow', async () => {
    const spool = createRedisAuditSpool(fakeRedis(), { maxDepth: 3 });
    for (let i = 0; i < 5; i++) await spool.enqueue({ event: evt('pipeline.create'), serviceName: `svc-${i}` });
    expect(await spool.depth()).toBe(3);
    // The three survivors are the NEWEST three (svc-2..svc-4).
    const survivors = (await spool.take(10)).map((e) => e.serviceName);
    expect(survivors).toEqual(['svc-2', 'svc-3', 'svc-4']);
  });

  it('requeue returns failed re-deliveries to the HEAD (retried first)', async () => {
    const spool = createRedisAuditSpool(fakeRedis());
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    const [taken] = await spool.take(1);
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'b' });
    await spool.requeue([taken]);
    // 'a' was requeued to the head, so it comes back before 'b'.
    expect((await spool.take(10)).map((e) => e.serviceName)).toEqual(['a', 'b']);
  });

  it('take moves entries to the in-progress list; ack clears them (reliable queue)', async () => {
    const redis = fakeRedis();
    const spool = createRedisAuditSpool(redis);
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'b' });

    const batch = await spool.take(10);
    // Main buffer drained, but the batch is parked on the in-progress list —
    // NOT dropped — so a crash here is recoverable.
    expect(redis._list('audit:spool')).toHaveLength(0);
    expect(redis._list('audit:spool:inflight')).toHaveLength(2);

    await spool.ack(batch);
    // Acked → gone from the in-progress list, nothing left to recover.
    expect(redis._list('audit:spool:inflight')).toHaveLength(0);
    expect(await spool.recover()).toBe(0);
  });

  it('recover reclaims a batch stranded on the in-progress list (crash mid-drain)', async () => {
    const redis = fakeRedis();
    const spool = createRedisAuditSpool(redis);
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'b' });

    // Simulate a crash: take() moves the batch to in-progress, then the process
    // dies before ack/requeue. A fresh spool over the same redis recovers it.
    await spool.take(10);
    expect(redis._list('audit:spool:inflight')).toHaveLength(2);

    const revived = createRedisAuditSpool(redis);
    expect(await revived.recover()).toBe(2);
    expect(redis._list('audit:spool:inflight')).toHaveLength(0);
    // Reclaimed to the main buffer in original order.
    expect((await revived.take(10)).map((e) => e.serviceName)).toEqual(['a', 'b']);
  });

  it('requeue returns failures to the head AND clears them from in-progress', async () => {
    const redis = fakeRedis();
    const spool = createRedisAuditSpool(redis);
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    const [taken] = await spool.take(1);
    await spool.requeue([taken]);
    // Back on the main buffer, and no longer stranded in-progress.
    expect(redis._list('audit:spool')).toHaveLength(1);
    expect(redis._list('audit:spool:inflight')).toHaveLength(0);
    expect(await spool.recover()).toBe(0);
  });

  it('is fail-safe: a throwing redis never propagates', async () => {
    const boom = {
      rpush: async () => { throw new Error('down'); },
      lpush: async () => { throw new Error('down'); },
      lpop: async () => { throw new Error('down'); },
      ltrim: async () => { throw new Error('down'); },
      llen: async () => { throw new Error('down'); },
      lmove: async () => { throw new Error('down'); },
      lrem: async () => { throw new Error('down'); },
    };
    const spool = createRedisAuditSpool(boom);
    await expect(spool.enqueue({ event: evt('pipeline.create'), serviceName: 'x' })).resolves.toBeUndefined();
    await expect(spool.take(5)).resolves.toEqual([]);
    await expect(spool.ack([{ event: evt('pipeline.create'), serviceName: 'x' }])).resolves.toBeUndefined();
    await expect(spool.recover()).resolves.toBe(0);
    await expect(spool.depth()).resolves.toBe(0);
  });
});
