// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DEFAULT_LEADER_LOCK_TTL_MS, leaderLockKey, withLeaderLock } from '../src/services/leader-lock.js';
import { resetCounterEmitter, setCounterEmitter } from '../src/utils/metric-emitter.js';

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

/**
 * Flush microtasks until `ready()`, bounded. `withLeaderLock` awaits readiness and
 * SET before invoking `fn`, so a fixed number of `await Promise.resolve()` calls is
 * a guess that breaks whenever those awaits change.
 */
async function flushUntil(ready: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !ready(); i++) await Promise.resolve();
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

/**
 * Every outcome is counted. The difference between "another pod ran it" (healthy)
 * and "Redis was unreachable so NOBODY ran it" (a silent fleet-wide stop) was
 * previously visible only as a log line, which is why a Redis blip could halt
 * every background sweep unnoticed.
 */
describe('withLeaderLock — outcome metrics', () => {
  const emitted: Array<{ name: string; labels?: Record<string, string> }> = [];

  beforeEach(() => {
    emitted.length = 0;
    setCounterEmitter((name, labels) => { emitted.push({ name, ...(labels ? { labels } : {}) }); });
  });
  afterEach(() => { resetCounterEmitter(); });

  const names = (): string[] => emitted.map((e) => e.name);

  it('counts an acquire when this pod runs the window', async () => {
    await withLeaderLock(fakeRedis({ acquire: true }) as never, 'k', 1000, async () => {});
    expect(names()).toContain('leader_lock_acquired_total');
    expect(emitted[0].labels).toEqual({ key: 'k' });
  });

  it('counts CONTENTION — not unavailability — when another holder owns it', async () => {
    // Healthy with replicas > 1: exactly one acquire per window fleet-wide.
    await withLeaderLock(fakeRedis({ acquire: false }) as never, 'k', 1000, async () => {});
    expect(names()).toEqual(['leader_lock_contended_total']);
    expect(names()).not.toContain('leader_lock_unavailable_total');
  });

  it('counts UNAVAILABILITY when Redis rejects, which means nobody ran', async () => {
    const redis = { set: jest.fn(async () => { throw new Error('not connected'); }), get: jest.fn(), del: jest.fn() };
    const ran = await withLeaderLock(redis as never, 'k', 1000, async () => {});
    expect(ran).toBe(false);
    expect(names()).toEqual(['leader_lock_unavailable_total']);
  });
});

/**
 * Shutdown. A running cycle used to keep its key until the TTL lapsed, so a
 * rolling deploy mid-run parked the job fleet-wide for the rest of the TTL. The
 * caller's signal is merged into the run's, so a signal-aware body returns and the
 * `finally` releases the lock.
 */
describe('withLeaderLock — caller shutdown signal', () => {
  it('does not take a lock when the caller has already aborted', async () => {
    const redis = fakeRedis({ acquire: true });
    const ac = new AbortController();
    ac.abort();
    const fn = jest.fn(async () => {});
    const ran = await withLeaderLock(redis as never, 'k', 1000, fn, { signal: ac.signal });
    expect(ran).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts the run signal when the caller aborts mid-run, and releases', async () => {
    const redis = fakeRedis({ acquire: true, getOwner: 'self' });
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const running = withLeaderLock(redis as never, 'k', 5000, ({ signal }) => {
      seen = signal;
      return new Promise<void>((r) => { finish = r; });
    }, { signal: ac.signal });

    // withLeaderLock awaits readiness and SET before calling fn, so flush until
    // the run has actually started rather than guessing a microtask count.
    await flushUntil(() => seen !== undefined);
    expect(seen?.aborted).toBe(false);
    ac.abort();
    expect(seen?.aborted).toBe(true);
    // The reason distinguishes shutdown from a lost lock — a body may want to log
    // them differently even though it stops either way.
    expect(seen?.reason).toBe('shutdown');

    finish?.();
    await running;
    // Released rather than left to expire: that is the whole point.
    expect(redis.del).toHaveBeenCalledWith('k');
  });

  it('reports lock-lost as the reason when a heartbeat loses it, not shutdown', async () => {
    jest.useFakeTimers();
    try {
      // eval returns 0 → the key is someone else's now.
      const redis = {
        set: jest.fn(async () => 'OK'),
        get: jest.fn(async () => 'someone-else'),
        del: jest.fn(async () => 1),
        eval: jest.fn(async () => 0),
      };
      let seen: AbortSignal | undefined;
      let finish: (() => void) | undefined;
      const running = withLeaderLock(redis as never, 'k', 300, ({ signal }) => {
        seen = signal;
        return new Promise<void>((r) => { finish = r; });
      }, { signal: new AbortController().signal });

      await flushUntil(() => seen !== undefined);
      await jest.advanceTimersByTimeAsync(200);
      expect(seen?.aborted).toBe(true);
      expect(seen?.reason).toBe('lock-lost');
      finish?.();
      await running;
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * One way to build a key. Four conventions had grown up, so no single glob found
 * every lock — `KEYS '*:leader'` missed billing's three unnamespaced ones.
 */
describe('leaderLockKey', () => {
  it('is <service>:<job>:leader', () => {
    expect(leaderLockKey('platform', 'org-purge')).toBe('platform:org-purge:leader');
  });

  it('puts the SERVICE first, so one service\'s locks sort and glob together', () => {
    const keys = [leaderLockKey('plugin', 'vuln-rescan'), leaderLockKey('plugin', 'ecosystem-stats')];
    expect(keys.every((k) => k.startsWith('plugin:'))).toBe(true);
    expect(keys.every((k) => k.endsWith(':leader'))).toBe(true);
  });
});

describe('DEFAULT_LEADER_LOCK_TTL_MS', () => {
  it('is a crash-recovery window, not a run-duration cover', () => {
    // The holder heartbeats for as long as the run takes, so the TTL only bounds
    // how long a job is blocked after a pod dies holding the lock. Callers used to
    // size it to the expected run time — up to SIX HOURS — which turned a crashed
    // pod into hours of silent inactivity.
    expect(DEFAULT_LEADER_LOCK_TTL_MS).toBe(120_000);
  });

  it('leaves at least three heartbeats of slack', () => {
    // Heartbeat is ttl/3, so an event-loop stall or a brief Redis blip must not
    // hand the lock to a second pod mid-run.
    expect(DEFAULT_LEADER_LOCK_TTL_MS / 3).toBeGreaterThanOrEqual(30_000);
  });
});
