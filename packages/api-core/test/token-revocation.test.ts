// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Redis-backed token-revocation helpers: the reader
 * (`createRedisTokenRevocationStore`) must fail open on every abnormal input,
 * and the publisher (`publishTokenRevocation`) must write the current version
 * with a floored TTL and never throw.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const {
  createRedisTokenRevocationStore,
  publishTokenRevocation,
  createEnvRedisTokenRevocationStore,
  tokenRevocationKey,
  TOKEN_REVOCATION_KEY_PREFIX,
  sessionRevocationKey,
  SESSION_REVOCATION_KEY_PREFIX,
  publishSessionRevocation,
  SET_IF_GREATER_LUA,
  credentialRevocationKey,
  publishCredentialRevocation,
} = await import('../src/services/token-revocation.js');

function fakeRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn<(k: string) => Promise<string | null>>(async () => null),
    set: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => 'OK'),
    del: jest.fn(async () => 1),
    ...overrides,
  } as any;
}

describe('tokenRevocationKey', () => {
  it('namespaces under the shared prefix', () => {
    expect(tokenRevocationKey('u1')).toBe(`${TOKEN_REVOCATION_KEY_PREFIX}u1`);
  });
});

describe('createRedisTokenRevocationStore.getCurrentVersion', () => {
  it('returns the parsed integer version on a hit', async () => {
    const store = createRedisTokenRevocationStore(fakeRedis({ get: jest.fn(async () => '7') }));
    expect(await store.getCurrentVersion('u1')).toBe(7);
  });

  it('reads the correctly-namespaced key', async () => {
    const get = jest.fn<(k: string) => Promise<string | null>>(async () => '3');
    const store = createRedisTokenRevocationStore(fakeRedis({ get }));
    await store.getCurrentVersion('u9');
    expect(get).toHaveBeenCalledWith(`${TOKEN_REVOCATION_KEY_PREFIX}u9`);
  });

  it('fail-opens (null) on a miss', async () => {
    const store = createRedisTokenRevocationStore(fakeRedis({ get: jest.fn(async () => null) }));
    expect(await store.getCurrentVersion('u1')).toBeNull();
  });

  it('fail-opens (null) on a corrupted / non-integer value', async () => {
    for (const bad of ['5abc', 'not-a-number', '5.5', '']) {
      const store = createRedisTokenRevocationStore(fakeRedis({ get: jest.fn(async () => bad) }));
      expect(await store.getCurrentVersion('u1')).toBeNull();
    }
  });

  it('fail-opens (null) when the Redis read throws (outage)', async () => {
    const store = createRedisTokenRevocationStore(fakeRedis({ get: jest.fn(async () => { throw new Error('redis down'); }) }));
    expect(await store.getCurrentVersion('u1')).toBeNull();
  });
});

describe('publishTokenRevocation', () => {
  let redis: ReturnType<typeof fakeRedis>;
  beforeEach(() => { redis = fakeRedis({ eval: jest.fn(async () => 1) }); });

  it('publishes through the atomic set-if-greater script (never a plain SET)', async () => {
    await publishTokenRevocation(redis, 'u1', 4, 900);
    expect(redis.eval).toHaveBeenCalledWith(SET_IF_GREATER_LUA, 1, `${TOKEN_REVOCATION_KEY_PREFIX}u1`, '4', 900);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('floors a fractional TTL and never uses EX 0', async () => {
    await publishTokenRevocation(redis, 'u1', 4, 0.4);
    expect(redis.eval).toHaveBeenCalledWith(SET_IF_GREATER_LUA, 1, `${TOKEN_REVOCATION_KEY_PREFIX}u1`, '4', 1);
  });

  it('refuses (without throwing) a client that cannot run scripts', async () => {
    const noEval = fakeRedis();
    await expect(publishTokenRevocation(noEval, 'u1', 4, 900)).resolves.toBeUndefined();
    expect(noEval.set).not.toHaveBeenCalled();
  });

  it('never throws when the Redis write fails (best-effort)', async () => {
    const bad = fakeRedis({ eval: jest.fn(async () => { throw new Error('redis down'); }) });
    await expect(publishTokenRevocation(bad, 'u1', 4, 900)).resolves.toBeUndefined();
  });

  it('the script only ever RAISES the stored version (out-of-order publishes)', async () => {
    // Emulate the Lua semantics against an in-memory store to pin the contract.
    const store = new Map<string, { v: string; ttl: number }>();
    const evalFake = jest.fn(async (_script: string, _n: number, key: string, v: string, ttl: number) => {
      const cur = store.get(key);
      if (cur && Number(cur.v) >= Number(v)) { if (cur.ttl < ttl) cur.ttl = ttl; return 0; }
      store.set(key, { v, ttl }); return 1;
    });
    const r = fakeRedis({ eval: evalFake });
    await publishTokenRevocation(r, 'u1', 7, 900);
    await publishTokenRevocation(r, 'u1', 5, 900); // stale, arrives late
    expect(store.get(tokenRevocationKey('u1'))!.v).toBe('7');
    expect(SET_IF_GREATER_LUA).toMatch(/cur >= v/);
  });
});

describe('credential revocation (revoke:sid / revoke:key)', () => {
  it('uses the agreed key shapes', () => {
    expect(credentialRevocationKey('sid', 's1')).toBe('revoke:sid:s1');
    expect(credentialRevocationKey('key', 'k1')).toBe('revoke:key:k1');
  });

  it('reader: any present entry among sid/key ids ⇒ revoked', async () => {
    const get = jest.fn(async (k: string) => (k === 'revoke:key:k2' ? '1' : null));
    const store = createRedisTokenRevocationStore(fakeRedis({ get }));
    await expect(store.isCredentialRevoked!({ sid: 's1', keyIds: ['k1', 'k2'] })).resolves.toBe(true);
    await expect(store.isCredentialRevoked!({ sid: 's1', keyIds: ['k1'] })).resolves.toBe(false);
    expect(get).toHaveBeenCalledWith('revoke:sid:s1');
  });

  it('reader: fail-open on a Redis error', async () => {
    const store = createRedisTokenRevocationStore(fakeRedis({ get: jest.fn(async () => { throw new Error('down'); }) }));
    await expect(store.isCredentialRevoked!({ sid: 's1', keyIds: [] })).resolves.toBe(false);
  });

  it('publisher writes the key with a ceil TTL and reports the outcome', async () => {
    const redis = fakeRedis();
    await expect(publishCredentialRevocation(redis, 'sid', 's1', 3600.2)).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith('revoke:sid:s1', '1', 'EX', 3601);
    const bad = fakeRedis({ set: jest.fn(async () => { throw new Error('down'); }) });
    await expect(publishCredentialRevocation(bad, 'key', 'k1', 60)).resolves.toBe(false);
  });
});

describe('createEnvRedisTokenRevocationStore', () => {
  const savedUrl = process.env.REDIS_URL;
  const savedSentinels = process.env.REDIS_SENTINELS;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = savedUrl;
    if (savedSentinels === undefined) delete process.env.REDIS_SENTINELS; else process.env.REDIS_SENTINELS = savedSentinels;
  });

  it('fail-opens (null) when neither REDIS_URL nor REDIS_SENTINELS is configured', async () => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_SENTINELS;
    const store = createEnvRedisTokenRevocationStore();
    expect(await store.getCurrentVersion('u1')).toBeNull();
    // Memoized "unavailable" — a second call is still a safe null (no throw).
    expect(await store.getCurrentVersion('u2')).toBeNull();
  });
});


describe('session revocation — Redis reader', () => {
  it('namespaces session keys apart from tokenVersion keys', () => {
    expect(sessionRevocationKey('j1')).toBe(`${SESSION_REVOCATION_KEY_PREFIX}j1`);
    expect(SESSION_REVOCATION_KEY_PREFIX).not.toBe(TOKEN_REVOCATION_KEY_PREFIX);
  });

  it('reads a present key as revoked and an absent key as live', async () => {
    const redis = fakeRedis({ get: jest.fn(async (k: string) => (k === sessionRevocationKey('ended') ? '1' : null)) });
    const store = createRedisTokenRevocationStore(redis);
    await expect(store.getSessionRevocation!('ended')).resolves.toBe('revoked');
    await expect(store.getSessionRevocation!('running')).resolves.toBe('live');
  });

  it('reads a Redis error as UNAVAILABLE, not live — this reader does not fail open', async () => {
    const store = createRedisTokenRevocationStore(fakeRedis({ get: jest.fn(async () => { throw new Error('down'); }) }));
    await expect(store.getSessionRevocation!('s')).resolves.toBe('unavailable');
  });

  it('reads "no Redis configured" as UNAVAILABLE for sessions', async () => {
    const saved = { url: process.env.REDIS_URL, sent: process.env.REDIS_SENTINELS };
    delete process.env.REDIS_URL; delete process.env.REDIS_SENTINELS;
    try {
      await expect(createEnvRedisTokenRevocationStore().getSessionRevocation!('s')).resolves.toBe('unavailable');
    } finally {
      if (saved.url !== undefined) process.env.REDIS_URL = saved.url;
      if (saved.sent !== undefined) process.env.REDIS_SENTINELS = saved.sent;
    }
  });
});

describe('publishSessionRevocation', () => {
  it('writes the session key with a millisecond TTL and reports success', async () => {
    const redis = fakeRedis();
    await expect(publishSessionRevocation(redis, 'j1', 120_000)).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(sessionRevocationKey('j1'), '1', 'PX', 120_000);
  });

  it('floors a tiny remaining TTL so the key is not written already-expired', async () => {
    const redis = fakeRedis();
    await publishSessionRevocation(redis, 'j1', 5);
    expect(redis.set).toHaveBeenCalledWith(sessionRevocationKey('j1'), '1', 'PX', 1000);
  });

  it('REPORTS a failed publish instead of swallowing it', async () => {
    // The caller must be able to tell whoever ended the session that it did not
    // end everywhere — unlike publishTokenRevocation, this is not fire-and-forget.
    const redis = fakeRedis({ set: jest.fn(async () => { throw new Error('down'); }) });
    await expect(publishSessionRevocation(redis, 'j1', 60_000)).resolves.toBe(false);
  });
});
