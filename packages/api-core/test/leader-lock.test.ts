// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { withLeaderLock } from '../src/services/leader-lock.js';

/** Fake ioredis-ish client. `acquire` controls whether SET NX succeeds;
 *  `getOwner` controls what GET returns at release time ('self' = our token). */
function fakeRedis(opts: { acquire: boolean; getOwner?: 'self' | string }) {
  let stored: string | null = null;
  const set = jest.fn(async (_key: string, val: string, ..._rest: unknown[]) => {
    if (!opts.acquire) return null;
    stored = val;
    return 'OK';
  });
  const get = jest.fn(async () => (opts.getOwner === undefined || opts.getOwner === 'self' ? stored : opts.getOwner));
  const del = jest.fn(async (..._keys: string[]) => 1);
  return { set, get, del };
}

describe('withLeaderLock', () => {
  it('runs fn and releases the lock when acquired', async () => {
    const redis = fakeRedis({ acquire: true, getOwner: 'self' });
    const fn = jest.fn(async () => {});
    const ran = await withLeaderLock(redis as never, 'k', 1000, fn);
    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('k');
  });

  it('skips the run — and does NOT reject — when Redis rejects the lock (e.g. not connected yet)', async () => {
    // Regression: platform crash-looped on minikube. Timers fire this with `void`,
    // so a rejection here was an unhandled rejection that exited the process.
    const redis = {
      set: jest.fn(async () => { throw new Error("Stream isn't writeable and enableOfflineQueue options is false"); }),
      get: jest.fn(async () => null),
      del: jest.fn(async () => 0),
    };
    const fn = jest.fn(async () => {});
    await expect(withLeaderLock(redis, 'k', 1000, fn)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes SET key token NX PX ttl', async () => {
    const redis = fakeRedis({ acquire: true, getOwner: 'self' });
    await withLeaderLock(redis as never, 'mykey', 5000, async () => {});
    expect(redis.set).toHaveBeenCalledWith('mykey', expect.any(String), 'PX', 5000, 'NX');
  });

  it('does not run fn and returns false when another holder owns the lock', async () => {
    const redis = fakeRedis({ acquire: false });
    const fn = jest.fn(async () => {});
    const ran = await withLeaderLock(redis as never, 'k', 1000, fn);
    expect(ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('does not delete a lock it no longer owns (TTL took over by another holder)', async () => {
    const redis = fakeRedis({ acquire: true, getOwner: 'someone-else' });
    await withLeaderLock(redis as never, 'k', 1000, async () => {});
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('still releases when fn throws, and propagates the error', async () => {
    const redis = fakeRedis({ acquire: true, getOwner: 'self' });
    await expect(withLeaderLock(redis as never, 'k', 1000, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(redis.del).toHaveBeenCalledWith('k');
  });

  it('releases via atomic eval (CAS) when the client supports it — no get-then-del race', async () => {
    const set = jest.fn(async () => 'OK');
    const get = jest.fn(async () => null);
    const del = jest.fn(async () => 1);
    const evalFn = jest.fn(async (..._args: unknown[]) => 1);
    const redis = { set, get, del, eval: evalFn };
    const ran = await withLeaderLock(redis as never, 'k', 1000, async () => {});
    expect(ran).toBe(true);
    // Atomic path: eval used with (script, 1, key, token); no separate get/del.
    expect(evalFn).toHaveBeenCalledWith(expect.stringContaining('redis.call'), 1, 'k', expect.any(String));
    expect(del).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('withLeaderLock — heartbeat + readiness (S5)', () => {
  /** A Lua-capable fake: tracks the owner token and PEXPIRE extensions. */
  function luaRedis() {
    const state: { owner: string | null; extends: number; status?: string; readyCb?: () => void } = { owner: null, extends: 0 };
    const client: any = {
      set: jest.fn(async (_k: string, v: string) => { if (state.owner) return null; state.owner = v; return 'OK'; }),
      get: jest.fn(async () => state.owner),
      del: jest.fn(async () => 1),
      eval: jest.fn(async (script: string, _n: number, _k: string, token: string) => {
        if (script.includes('pexpire')) { if (state.owner === token) { state.extends++; return 1; } return 0; }
        if (state.owner === token) { state.owner = null; return 1; }
        return 0;
      }),
    };
    return { client, state };
  }

  it('heartbeats (compare-and-PEXPIRE) while a long run is in progress', async () => {
    jest.useFakeTimers();
    try {
      const { client, state } = luaRedis();
      let finish!: () => void;
      const running = withLeaderLock(client, 'job', 300, () => new Promise<void>((r) => { finish = r; }));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000); // > 3 × (ttl/3)
      expect(state.extends).toBeGreaterThanOrEqual(3);
      finish();
      await expect(running).resolves.toBe(true);
      const beats = state.extends;
      await jest.advanceTimersByTimeAsync(1000);
      expect(state.extends).toBe(beats); // heartbeat stops with the run
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts run.signal when a heartbeat finds the lock taken over', async () => {
    jest.useFakeTimers();
    try {
      const { client, state } = luaRedis();
      let seen: AbortSignal | undefined;
      let finish!: () => void;
      const running = withLeaderLock(client, 'job', 300, ({ signal }) => { seen = signal; return new Promise<void>((r) => { finish = r; }); });
      await jest.advanceTimersByTimeAsync(0);
      expect(seen!.aborted).toBe(false);
      state.owner = 'someone-else'; // our lock lapsed and another pod took it
      await jest.advanceTimersByTimeAsync(150);
      expect(seen!.aborted).toBe(true);
      finish();
      await running;
      expect(state.owner).toBe('someone-else'); // release never frees theirs
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for a connecting client to be ready before SET NX (first tick after boot runs)', async () => {
    const { client } = luaRedis();
    let onReady: (() => void) | undefined;
    client.status = 'connecting';
    client.once = (_e: string, cb: () => void) => { onReady = cb; };
    client.off = () => undefined;
    const fn = jest.fn(async () => {});
    const running = withLeaderLock(client, 'job', 5000, fn);
    await new Promise((r) => setImmediate(r));
    expect(client.set).not.toHaveBeenCalled();
    client.status = 'ready';
    onReady!();
    await expect(running).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
