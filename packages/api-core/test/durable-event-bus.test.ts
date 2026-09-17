// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the durable event bus (Redis Streams) against an in-memory fake
 * stream client that implements the xadd/xgroup/xreadgroup/xack/xautoclaim subset.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { createRedisDurableEventBus } = await import('../src/services/durable-event-bus.js');

type Entry = { id: string; payload: string; pendingSince?: number; consumer?: string; deliveries?: number };

/**
 * Minimal in-memory Redis Streams fake. One stream, one group is enough for the
 * bus's semantics. `xreadgroup` with BLOCK yields a microtask when empty so the
 * consumer loop never hot-spins; delivery/redelivery is driven by the handler.
 */
function makeFakeStream() {
  const entries: Entry[] = [];
  let seq = 0;
  const groups = new Map<string, { cursor: number; pending: Map<string, Entry> }>();

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const dlq: Array<Record<string, string>> = [];
  let publishCalls = 0;
  const fake = {
    entries,
    groups,
    dlq,
    get publishCalls() { return publishCalls; },
    duplicates: 0,
    duplicate() { fake.duplicates++; return fake; },
    async quit() { return 'OK'; },
    async xadd(key: string, ...args: (string | number)[]) {
      if (key.endsWith(':dlq')) {
        // MAXLEN ~ n * field value ...
        const fields = args.slice(4).map(String);
        const rec: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) rec[fields[i]] = fields[i + 1];
        dlq.push(rec);
        return `${dlq.length}-0`;
      }
      publishCalls++;
      // ...MAXLEN ~ n * d <json>
      const payload = String(args[args.length - 1]);
      const id = `${1_700_000_000_000 + ++seq}-0`;
      entries.push({ id, payload });
      return id;
    },
    async xpending(_key: string, group: string, ..._args: (string | number)[]) {
      const g = groups.get(group);
      if (!g) return [];
      return [...g.pending.values()].map((e) => [e.id, e.consumer ?? 'c', 0, e.deliveries ?? 1]);
    },
    async xrange(_key: string, start: string) {
      const e = entries.find((x) => x.id === start);
      return e ? [[e.id, ['d', e.payload]]] : [];
    },
    async xgroup(...args: (string | number)[]) {
      const [cmd, , group] = args as [string, string, string];
      if (cmd !== 'CREATE') return 'OK';
      if (groups.has(group)) throw new Error('BUSYGROUP Consumer Group name already exists');
      groups.set(group, { cursor: entries.length, pending: new Map() });
      return 'OK';
    },
    async xreadgroup(...args: (string | number)[]) {
      // GROUP group consumer COUNT n BLOCK ms STREAMS key '>'
      const group = String(args[1]);
      const consumer = String(args[2]);
      const count = Number(args[4]);
      const g = groups.get(group);
      if (!g) return null;
      const batch: Entry[] = [];
      while (g.cursor < entries.length && batch.length < count) {
        const e = entries[g.cursor++];
        e.pendingSince = 0; // idle-from epoch so minIdle=0 reclaims deterministically
        e.consumer = consumer;
        e.deliveries = 1;
        g.pending.set(e.id, e);
        batch.push(e);
      }
      if (batch.length === 0) { await sleep(1); return null; }
      return [['evt:t', batch.map((e) => [e.id, ['d', e.payload]])]];
    },
    async xack(_key: string, group: string, ...ids: string[]) {
      const g = groups.get(group);
      if (!g) return 0;
      let n = 0;
      for (const id of ids) if (g.pending.delete(id)) n++;
      return n;
    },
    async xautoclaim(...args: (string | number)[]) {
      // key group consumer minIdle start COUNT n
      const group = String(args[1]);
      const count = Number(args[6]);
      const g = groups.get(group);
      if (!g) return ['0-0', [], []];
      const claimable = [...g.pending.values()].slice(0, count);
      for (const e of claimable) e.deliveries = (e.deliveries ?? 1) + 1;
      return ['0-0', claimable.map((e) => [e.id, ['d', e.payload]]), []];
    },
  };
  return fake;
}

describe('durable event bus', () => {
  beforeEach(() => jest.useRealTimers());
  afterEach(() => jest.useRealTimers());

  it('publish XADDs and returns the stream id', async () => {
    const fake = makeFakeStream();
    const bus = createRedisDurableEventBus(fake as never);
    const id = await bus.publish('t', { hello: 'world' });
    expect(id).toBe('1700000000001-0');
    expect(fake.entries[0].payload).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('publish returns null (never throws) when XADD fails', async () => {
    const bus = createRedisDurableEventBus({ xadd: async () => { throw new Error('down'); } } as never);
    await expect(bus.publish('t', { a: 1 })).resolves.toBeNull();
  });

  it('delivers a published event to a subscriber and acks it', async () => {
    const fake = makeFakeStream();
    const bus = createRedisDurableEventBus(fake as never);
    const received: unknown[] = [];
    const publishedAts: Date[] = [];
    let resolveGot: () => void;
    const got = new Promise<void>((r) => { resolveGot = r; });

    const sub = bus.subscribe<{ n: number }>({
      topic: 't',
      group: 'g1',
      consumer: 'c1',
      handler: async (env) => { received.push(env.payload); publishedAts.push(env.publishedAt); resolveGot(); },
      blockMs: 1,
      minIdleMs: 0,
    });
    await bus.publish('t', { n: 42 });
    await got;
    await sub.stop();

    expect(received).toEqual([{ n: 42 }]);
    // The publish time comes from the stream id, not the delivery time.
    expect(publishedAts).toEqual([new Date(1_700_000_000_001)]);
    // Acked ⇒ no longer pending for the group.
    expect(fake.groups.get('g1')!.pending.size).toBe(0);
  });

  it('leaves a message pending when the handler throws, then redelivers via autoclaim', async () => {
    const fake = makeFakeStream();
    const bus = createRedisDurableEventBus(fake as never);
    let calls = 0;
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });

    const sub = bus.subscribe<{ n: number }>({
      topic: 't',
      group: 'g1',
      consumer: 'c1',
      handler: async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        resolveDone(); // second delivery (the redelivery) succeeds
      },
      blockMs: 1,
      minIdleMs: 0,
    });
    await bus.publish('t', { n: 7 });
    await done;
    await sub.stop();

    expect(calls).toBeGreaterThanOrEqual(2); // failed once, redelivered, succeeded
    expect(fake.groups.get('g1')!.pending.size).toBe(0); // eventually acked
  });

  it('keeps trying to create the consumer group when Redis is not ready at startup', async () => {
    const fake = makeFakeStream();
    const realXgroup = fake.xgroup.bind(fake);
    let attempts = 0;
    fake.xgroup = async (...args: (string | number)[]) => {
      attempts++;
      if (attempts === 1) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      return realXgroup(...args);
    };
    const bus = createRedisDurableEventBus(fake as never);
    let resolveGot: () => void;
    const got = new Promise<void>((r) => { resolveGot = r; });

    const sub = bus.subscribe<{ n: number }>({
      topic: 't',
      group: 'g1',
      consumer: 'c1',
      blockMs: 1,
      minIdleMs: 0,
      handler: async () => { resolveGot(); },
    });
    // Once the group exists (after the backoff), a new event is delivered.
    while (!fake.groups.has('g1')) await new Promise((r) => setTimeout(r, 20));
    await bus.publish('t', { n: 1 });
    await got;
    await sub.stop();

    expect(attempts).toBe(2);
  });

  it('reads on a dedicated connection so a blocking XREADGROUP never delays publish', async () => {
    const data = makeFakeStream();
    /** One Redis CONNECTION: commands run strictly one after another (like a real socket). */
    const connection = (): Record<string, unknown> => {
      let chain: Promise<unknown> = Promise.resolve();
      const serial = (fn: (...a: never[]) => Promise<unknown>) => (...args: never[]) => {
        const run = chain.then(() => fn(...args));
        chain = run.catch(() => undefined);
        return run;
      };
      const conn: Record<string, unknown> = { duplicate: () => connection(), quit: async () => 'OK' };
      for (const m of ['xadd', 'xgroup', 'xack', 'xautoclaim', 'xpending', 'xrange'] as const) {
        conn[m] = serial((data[m] as (...a: never[]) => Promise<unknown>).bind(data));
      }
      // BLOCK: an empty read holds the connection for the whole block window.
      conn.xreadgroup = serial(() => new Promise((r) => setTimeout(() => r(null), 800)));
      return conn;
    };
    const bus = createRedisDurableEventBus(connection() as never);
    const sub = bus.subscribe({ topic: 't', group: 'g', consumer: 'c', handler: async () => undefined, blockMs: 800 });
    await new Promise((r) => setTimeout(r, 20)); // the reader is now blocked in XREADGROUP
    const started = Date.now();
    await bus.publish('t', { a: 1 });
    expect(Date.now() - started).toBeLessThan(300);
    await sub.stop();
  });

  it('dead-letters a message after maxDeliveries failed deliveries instead of redelivering forever', async () => {
    const fake = makeFakeStream();
    const bus = createRedisDurableEventBus(fake as never);
    let calls = 0;
    const sub = bus.subscribe<{ n: number }>({
      topic: 't',
      group: 'g1',
      consumer: 'c1',
      blockMs: 1,
      minIdleMs: 0,
      maxDeliveries: 3,
      handler: async () => { calls++; throw new Error('poison'); },
    });
    const id = await bus.publish('t', { n: 9 });
    for (let i = 0; i < 200 && fake.dlq.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await sub.stop();

    expect(calls).toBe(3);
    expect(fake.dlq).toEqual([{ d: JSON.stringify({ n: 9 }), sourceId: id, group: 'g1', deliveries: '3' }]);
    expect(fake.groups.get('g1')!.pending.size).toBe(0);
  });

  it('createEnvRedisDurableEventBus returns null when Redis is not configured', async () => {
    const prev = { ...process.env };
    delete process.env.REDIS_URL;
    delete process.env.REDIS_SENTINELS;
    const { createEnvRedisDurableEventBus } = await import('../src/services/durable-event-bus.js');
    expect(createEnvRedisDurableEventBus()).toBeNull();
    process.env = prev;
  });
});

/** Real Redis (opt-in: API_CORE_TEST_REDIS_URL): XPENDING/XRANGE reply shapes, dead-lettering and publishedAt. */
const REAL_URL = process.env.API_CORE_TEST_REDIS_URL;
(REAL_URL ? describe : describe.skip)('durable event bus (real Redis)', () => {
  it('delivers with the publish time and dead-letters after maxDeliveries', async () => {
    const { Redis } = await import('ioredis');
    const client = new Redis(REAL_URL!);
    const topic = `test-${Date.now()}`;
    try {
      const bus = createRedisDurableEventBus(client as never);
      const seen: Array<{ publishedAt: Date }> = [];
      const before = Date.now();
      const sub = bus.subscribe({
        topic,
        group: 'g',
        consumer: 'c',
        blockMs: 20,
        minIdleMs: 0,
        maxDeliveries: 2,
        handler: async (env) => { seen.push(env); throw new Error('poison'); },
      });
      await new Promise((r) => setTimeout(r, 100));
      const id = await bus.publish(topic, { n: 1 });
      for (let i = 0; i < 100; i++) {
        if ((await client.xlen(`evt:${topic}:dlq`)) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await sub.stop();
      expect(seen).toHaveLength(2);
      expect(seen[0].publishedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(seen[1].publishedAt.getTime()).toBe(seen[0].publishedAt.getTime());
      const dlq = await client.xrange(`evt:${topic}:dlq`, '-', '+');
      expect(dlq).toHaveLength(1);
      expect(dlq[0][1]).toEqual(['d', JSON.stringify({ n: 1 }), 'sourceId', id, 'group', 'g', 'deliveries', '2']);
      const pending = await client.xpending(`evt:${topic}`, 'g');
      expect(pending[0]).toBe(0);
    } finally {
      await client.del(`evt:${topic}`, `evt:${topic}:dlq`);
      await client.quit();
    }
  });
});
