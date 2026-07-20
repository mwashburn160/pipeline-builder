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
  tokenRevocationKey,
  TOKEN_REVOCATION_KEY_PREFIX,
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
