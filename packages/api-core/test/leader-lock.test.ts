// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { withLeaderLock } from '../src/services/leader-lock.js';

/** Fake ioredis-ish client. `acquire` controls whether SET NX succeeds;
 *  `getOwner` controls what GET returns at release time ('self' = our token). */
function fakeRedis(opts: { acquire: boolean; getOwner?: 'self' | string }) {
  let stored: string | null = null;
  const set = jest.fn(async (_key: string, val: string) => {
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
    const evalFn = jest.fn(async () => 1);
    const redis = { set, get, del, eval: evalFn };
    const ran = await withLeaderLock(redis as never, 'k', 1000, async () => {});
    expect(ran).toBe(true);
    // Atomic path: eval used with (script, 1, key, token); no separate get/del.
    expect(evalFn).toHaveBeenCalledWith(expect.stringContaining('redis.call'), 1, 'k', expect.any(String));
    expect(del).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
