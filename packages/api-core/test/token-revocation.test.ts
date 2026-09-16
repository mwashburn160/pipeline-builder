// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Redis-backed token-revocation helpers: the reader
 * (`createRedisTokenRevocationStore`) must fail open on every abnormal input,
 * and the publisher (`publishTokenRevocation`) must write the current version
 * with a floored TTL and never throw.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

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
} = await import('../src/services/token-revocation.js');

function fakeRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn<(k: string) => Promise<string | null>>(async () => null),
    set: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => 'OK'),
    del: jest.fn(async () => 1),
    keys: jest.fn(async () => []),
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
  beforeEach(() => { redis = fakeRedis(); });

  it('writes the version at the namespaced key with SET EX <ttl>', async () => {
    await publishTokenRevocation(redis, 'u1', 4, 900);
    expect(redis.set).toHaveBeenCalledWith(`${TOKEN_REVOCATION_KEY_PREFIX}u1`, '4', 'EX', 900);
  });

  it('floors a fractional TTL and never uses EX 0', async () => {
    await publishTokenRevocation(redis, 'u1', 4, 0.4);
    expect(redis.set).toHaveBeenCalledWith(`${TOKEN_REVOCATION_KEY_PREFIX}u1`, '4', 'EX', 1);
  });

  it('never throws when the Redis write fails (best-effort)', async () => {
    const bad = fakeRedis({ set: jest.fn(async () => { throw new Error('redis down'); }) });
    await expect(publishTokenRevocation(bad, 'u1', 4, 900)).resolves.toBeUndefined();
  });
});

describe('createEnvRedisTokenRevocationStore', () => {
  const savedUrl = process.env.REDIS_URL;
  const savedHost = process.env.REDIS_HOST;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = savedUrl;
    if (savedHost === undefined) delete process.env.REDIS_HOST; else process.env.REDIS_HOST = savedHost;
  });

  it('fail-opens (null) when neither REDIS_URL nor REDIS_HOST is configured', async () => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
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
    const saved = { url: process.env.REDIS_URL, host: process.env.REDIS_HOST, sent: process.env.REDIS_SENTINELS };
    delete process.env.REDIS_URL; delete process.env.REDIS_HOST; delete process.env.REDIS_SENTINELS;
    try {
      await expect(createEnvRedisTokenRevocationStore().getSessionRevocation!('s')).resolves.toBe('unavailable');
    } finally {
      if (saved.url !== undefined) process.env.REDIS_URL = saved.url;
      if (saved.host !== undefined) process.env.REDIS_HOST = saved.host;
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
