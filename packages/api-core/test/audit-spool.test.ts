// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { createRedisAuditSpool } from '../src/services/audit-spool.js';
import type { RemoteAuditEvent } from '../src/services/remote-audit-client.js';

/** In-memory stand-in for the ioredis LIST surface the spool uses. */
function fakeRedis() {
  let list: string[] = [];
  return {
    async rpush(_k: string, ...v: string[]) { list.push(...v); return list.length; },
    async lpush(_k: string, ...v: string[]) { list.unshift(...[...v].reverse()); return list.length; },
    async lpop(_k: string, count: number) { const out = list.splice(0, count); return out.length ? out : null; },
    async ltrim(_k: string, start: number, stop: number) { list = list.slice(start, stop === -1 ? undefined : stop + 1); },
    async llen(_k: string) { return list.length; },
    _list: () => list,
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

  it('is fail-safe: a throwing redis never propagates', async () => {
    const boom = {
      rpush: async () => { throw new Error('down'); },
      lpush: async () => { throw new Error('down'); },
      lpop: async () => { throw new Error('down'); },
      ltrim: async () => { throw new Error('down'); },
      llen: async () => { throw new Error('down'); },
    };
    const spool = createRedisAuditSpool(boom);
    await expect(spool.enqueue({ event: evt('pipeline.create'), serviceName: 'x' })).resolves.toBeUndefined();
    await expect(spool.take(5)).resolves.toEqual([]);
    await expect(spool.depth()).resolves.toBe(0);
  });
});
