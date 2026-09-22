// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { auditSpoolKey, createRedisAuditSpool } from '../src/services/audit-spool.js';
import type { RemoteAuditEvent } from '../src/services/remote-audit-client.js';

/** In-memory stand-in for the ioredis LIST surface the spool uses. Keyed by
 *  list name so the main buffer and the `:inflight` in-progress list coexist. */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const zsets = new Map<string, Map<string, number>>();
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
    async zadd(k: string, score: number, member: string) { const z = zsets.get(k) ?? new Map(); z.set(member, score); zsets.set(k, z); return 1; },
    async zrangebyscore(k: string, min: number | string, max: number | string) {
      const lo = min === '-inf' ? -Infinity : Number(min); const hi = max === '+inf' ? Infinity : Number(max);
      return [...(zsets.get(k) ?? new Map()).entries()].filter(([, v]) => v >= lo && v <= hi).map(([m]) => m);
    },
    async zrem(k: string, member: string) { return zsets.get(k)?.delete(member) ? 1 : 0; },
    _list: (k = KEY) => get(k),
    _zset: (k = `${KEY}:owners`) => zsets.get(k) ?? new Map(),
  };
}

const KEY = 'audit:spool:pipeline';
const INFLIGHT = (owner: string) => `${KEY}:inflight:${owner}`;
/** A spool as owner `owner` over the given fake. */
const spoolOf = (redis: ReturnType<typeof fakeRedis>, owner = 'pod-1', extra: Record<string, unknown> = {}) =>
  createRedisAuditSpool(redis, { key: KEY, ownerId: owner, ...extra });

const evt = (action: string): RemoteAuditEvent => ({ action: action as RemoteAuditEvent['action'], actorId: 'u1' });

describe('createRedisAuditSpool', () => {
  it('enqueue/take round-trips entries FIFO and removes them', async () => {
    const spool = spoolOf(fakeRedis());
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'pipeline' });
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'pipeline' });
    expect(await spool.depth()).toBe(2);

    const batch = await spool.take(10);
    expect(batch.map((e) => e.event.action)).toEqual(['pipeline.create', 'pipeline.update']);
    expect(await spool.depth()).toBe(0);
    expect(await spool.take(10)).toEqual([]);
  });

  it('bounds the buffer, dropping the OLDEST on overflow', async () => {
    const spool = spoolOf(fakeRedis(), 'pod-1', { maxDepth: 3 });
    for (let i = 0; i < 5; i++) await spool.enqueue({ event: evt('pipeline.create'), serviceName: `svc-${i}` });
    expect(await spool.depth()).toBe(3);
    // The three survivors are the NEWEST three (svc-2..svc-4).
    const survivors = (await spool.take(10)).map((e) => e.serviceName);
    expect(survivors).toEqual(['svc-2', 'svc-3', 'svc-4']);
  });

  it('requeue returns failed re-deliveries to the HEAD (retried first)', async () => {
    const spool = spoolOf(fakeRedis());
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    const [taken] = await spool.take(1);
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'b' });
    await spool.requeue([taken]);
    // 'a' was requeued to the head, so it comes back before 'b'.
    expect((await spool.take(10)).map((e) => e.serviceName)).toEqual(['a', 'b']);
  });

  it('take moves entries to the in-progress list; ack clears them (reliable queue)', async () => {
    const redis = fakeRedis();
    const spool = spoolOf(redis);
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'b' });

    const batch = await spool.take(10);
    // Main buffer drained, but the batch is parked on the in-progress list —
    // NOT dropped — so a crash here is recoverable.
    expect(redis._list(KEY)).toHaveLength(0);
    expect(redis._list(INFLIGHT('pod-1'))).toHaveLength(2);

    await spool.ack(batch);
    // Acked → gone from the in-progress list, nothing left to recover.
    expect(redis._list(INFLIGHT('pod-1'))).toHaveLength(0);
    expect(await spool.recover()).toBe(0);
  });

  it('recover reclaims a batch stranded by a DEAD owner (stale heartbeat), in order', async () => {
    const redis = fakeRedis();
    const spool = spoolOf(redis, 'pod-dead', { staleOwnerMs: 1000 });
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    await spool.enqueue({ event: evt('pipeline.update'), serviceName: 'b' });

    // Crash: take() moves the batch to pod-dead's in-progress list, then the
    // process dies before ack/requeue — and stops heartbeating.
    await spool.take(10);
    expect(redis._list(INFLIGHT('pod-dead'))).toHaveLength(2);
    redis._zset().set('pod-dead', Date.now() - 5000);

    const survivor = spoolOf(redis, 'pod-2', { staleOwnerMs: 1000 });
    expect(await survivor.recover()).toBe(2);
    expect(redis._list(INFLIGHT('pod-dead'))).toHaveLength(0);
    expect(redis._zset().has('pod-dead')).toBe(false);
    // Reclaimed to the main buffer in original order.
    expect((await survivor.take(10)).map((e) => e.serviceName)).toEqual(['a', 'b']);
  });

  it('recover NEVER takes a LIVE owner\u2019s in-flight batch (no duplicate delivery)', async () => {
    const redis = fakeRedis();
    const busy = spoolOf(redis, 'pod-busy');
    await busy.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    await busy.take(10); // mid-delivery; heartbeat is fresh
    const peer = spoolOf(redis, 'pod-new');
    expect(await peer.recover()).toBe(0);
    expect(redis._list(INFLIGHT('pod-busy'))).toHaveLength(1);
  });

  it('keys are per service', () => {
    expect(auditSpoolKey('plugin')).toBe('audit:spool:plugin');
    expect(auditSpoolKey('plugin')).not.toBe(auditSpoolKey('billing'));
  });

  it('waits for the client to be ready before its first command', async () => {
    const redis = fakeRedis();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const spool = spoolOf(redis, 'pod-1', { ready: async () => { order.push('wait'); await gate; order.push('ready'); } });
    const p = spool.recover();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['wait']);
    expect(redis._zset().size).toBe(0); // nothing sent yet
    release();
    await p;
    expect(order).toEqual(['wait', 'ready']);
    expect(redis._zset().has('pod-1')).toBe(true);
  });

  it('requeue returns failures to the head AND clears them from in-progress', async () => {
    const redis = fakeRedis();
    const spool = spoolOf(redis);
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    const [taken] = await spool.take(1);
    await spool.requeue([taken]);
    // Back on the main buffer, and no longer stranded in-progress.
    expect(redis._list(KEY)).toHaveLength(1);
    expect(redis._list(INFLIGHT('pod-1'))).toHaveLength(0);
    expect(await spool.recover()).toBe(0);
  });

  it('requeue is at-least-once: a crash between lpush and lrem keeps the event (never lost)', async () => {
    // Ordering invariant: requeue must lpush to the main list BEFORE lrem-ing
    // from in-progress, so a crash in the gap leaves the event on BOTH lists
    // (harmless double-delivery) rather than dropping it. Simulate the crash by
    // making the FIRST lrem after a successful lpush throw.
    const redis = fakeRedis();
    let lpushed = false;
    const origLpush = redis.lpush.bind(redis);
    const origLrem = redis.lrem.bind(redis);
    redis.lpush = async (k: string, ...v: string[]) => { lpushed = true; return origLpush(k, ...v); };
    redis.lrem = async (k: string, count: number, value: string) => {
      if (lpushed && k === INFLIGHT('pod-1')) throw new Error('crash after lpush, before lrem');
      return origLrem(k, count, value);
    };

    const spool = spoolOf(redis);
    await spool.enqueue({ event: evt('pipeline.create'), serviceName: 'a' });
    const [taken] = await spool.take(1);
    // in-progress holds it; main is empty.
    expect(redis._list(KEY)).toHaveLength(0);
    expect(redis._list(INFLIGHT('pod-1'))).toHaveLength(1);

    await spool.requeue([taken]); // lpush succeeds, then lrem throws (swallowed)

    // The event survived on the MAIN list (re-deliverable). It is ALSO still on
    // in-progress — that duplicate is reclaimed by recover and deduped downstream,
    // which is acceptable; LOSING it would not be.
    expect(redis._list(KEY)).toHaveLength(1);
    expect(redis._list(INFLIGHT('pod-1'))).toHaveLength(1);
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
      zadd: async () => { throw new Error('down'); },
      zrangebyscore: async () => { throw new Error('down'); },
      zrem: async () => { throw new Error('down'); },
    };
    const spool = createRedisAuditSpool(boom, { key: KEY });
    await expect(spool.enqueue({ event: evt('pipeline.create'), serviceName: 'x' })).resolves.toBeUndefined();
    await expect(spool.take(5)).resolves.toEqual([]);
    await expect(spool.ack([{ event: evt('pipeline.create'), serviceName: 'x' }])).resolves.toBeUndefined();
    await expect(spool.recover()).resolves.toBe(0);
    await expect(spool.heartbeat()).resolves.toBeUndefined();
    await expect(spool.depth()).resolves.toBe(0);
  });
});
