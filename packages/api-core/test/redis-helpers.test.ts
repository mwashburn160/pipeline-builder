// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest } from '@jest/globals';
import { makeFakeRedis } from './helpers/fake-redis.js';
import { createRedisReadyGate, incrWindow } from '../src/services/env-redis.js';

describe('incrWindow', () => {
  it('increments and sets the window TTL in ONE atomic call (no separate EXPIRE to lose)', async () => {
    const fake = makeFakeRedis();
    expect(await incrWindow(fake, 'k', 1_000)).toBe(1);
    expect(await incrWindow(fake, 'k', 1_000)).toBe(2);
    expect(fake.calls).toEqual(['eval', 'eval']);
    expect(fake.strings.get('k')!.expiresAt).toBeLessThan(Number.POSITIVE_INFINITY);
  });

  it('passes the script the key and a positive integer window', async () => {
    const evalFn = jest.fn(async (..._a: unknown[]) => 3);
    expect(await incrWindow({ eval: evalFn as never }, 'rl:x', 1500.2)).toBe(3);
    expect(evalFn).toHaveBeenCalledWith(expect.stringContaining('PEXPIRE'), 1, 'rl:x', 1501);
  });

  const REAL_URL = process.env.API_CORE_TEST_REDIS_URL;
  (REAL_URL ? it : it.skip)('real Redis: counter expires and a TTL-less key is healed', async () => {
    const { Redis } = await import('ioredis');
    const client = new Redis(REAL_URL!);
    try {
      const key = `incrwindow-test-${Date.now()}`;
      await client.set(key, '5'); // simulates a key whose EXPIRE was lost
      expect(await incrWindow(client as never, key, 1_000)).toBe(6);
      expect(await client.pttl(key)).toBeGreaterThan(0);
      await client.pexpire(key, 20);
      await new Promise((r) => setTimeout(r, 60));
      expect(await incrWindow(client as never, key, 1_000)).toBe(1);
    } finally {
      await client.quit();
    }
  });
});

function fakeClient(status: string) {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    status,
    once(evt: string, cb: () => void) { (listeners[evt] ||= []).push(cb); },
    off(evt: string, cb: () => void) { listeners[evt] = (listeners[evt] || []).filter((c) => c !== cb); },
    emit(evt: string) { const cbs = listeners[evt] || []; listeners[evt] = []; cbs.forEach((c) => c()); },
  };
}

describe('createRedisReadyGate', () => {
  it('resolves immediately for a ready client or a test double without status', async () => {
    await expect(createRedisReadyGate(fakeClient('ready'))()).resolves.toBeUndefined();
    await expect(createRedisReadyGate({})()).resolves.toBeUndefined();
  });

  it('waits for ready, sharing one wait across concurrent callers', async () => {
    const c = fakeClient('connecting');
    const gate = createRedisReadyGate(c, 5_000);
    let done = 0;
    void gate().then(() => done++);
    void gate().then(() => done++);
    await Promise.resolve();
    expect(done).toBe(0);
    c.status = 'ready';
    c.emit('ready');
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(2);
  });

  it('never rejects: after a timeout it stops waiting until the client is ready again', async () => {
    jest.useFakeTimers();
    try {
      const c = fakeClient('reconnecting');
      const gate = createRedisReadyGate(c, 2_000);
      const first = gate();
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toBeUndefined();
      // Down: no further waiting.
      let settled = false;
      void gate().then(() => { settled = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(true);
      // Recovered then dropped again: waits once more.
      c.emit('ready');
      let again = false;
      void gate().then(() => { again = true; });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(again).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(again).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
