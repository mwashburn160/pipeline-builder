// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the session-revocation PUBLISHER (helpers/session-revocation.ts).
 *
 * The publisher reads a user's CURRENT tokenVersion from Mongo and hands it to
 * api-core's `publishTokenRevocation`, which writes the Redis entry the stateless
 * services read. We assert:
 *   - single + batch publish write the current version with a TTL >= the longest
 *     access-token lifetime (max of ceiling / base / tier override);
 *   - it is best-effort: no Redis, a missing user, or a DB error never throws.
 *
 * `publishTokenRevocation` is overridden to a faithful impl that hits a fake
 * redis (capturing `set` calls), and `getRedisClient` is mocked to return it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/** Fake ioredis-shaped client capturing SETs. */
const fakeRedis = {
  set: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => 'OK'),
  get: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(),
};
const mockGetRedis = jest.fn<() => Promise<unknown>>(async () => fakeRedis);
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFind = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // Faithful to api-core: SET authrev:tv:<userId> <version> EX <ttl>.
  publishTokenRevocation: async (redis: { set: (...a: unknown[]) => Promise<unknown> }, userId: string, version: number, ttl: number) => {
    await redis.set(`authrev:tv:${userId}`, String(version), 'EX', ttl);
  },
}));

// TTL ceiling 3600, base 900, one tier override 1800 → effective max = 3600.
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      jwt: { expiresIn: 900, tierExpiresIn: { developer: undefined, enterprise: 1800 } },
      sessionRevocationTtlSeconds: 3600,
    },
    redis: { url: 'redis://test:6379' },
  },
}));

jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: (...a: unknown[]) => mockGetRedis(...a),
  __resetRedisClientForTests: () => {},
}));

jest.unstable_mockModule('../src/models/user.js', () => ({
  __esModule: true,
  default: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
    find: (...a: unknown[]) => mockUserFind(...a),
  },
}));

const { publishUserRevocation, publishUsersRevocation } = await import('../src/helpers/session-revocation.js');

/** User.findById(id).select('+tokenVersion').lean() → doc */
const findByIdResolves = (doc: unknown) =>
  mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) });
/** User.find({...}).select('+tokenVersion').lean() → rows */
const findResolves = (rows: unknown[]) =>
  mockUserFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRedis.mockResolvedValue(fakeRedis);
});

describe('publishUserRevocation', () => {
  it('publishes the user CURRENT tokenVersion with the ceiling TTL', async () => {
    findByIdResolves({ _id: 'u1', tokenVersion: 7 });

    await publishUserRevocation('u1');

    expect(fakeRedis.set).toHaveBeenCalledTimes(1);
    // key, value(version), 'EX', ttl(max(3600,900,1800)=3600)
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:u1', '7', 'EX', 3600);
  });

  it('no-ops (no throw) when Redis is unavailable', async () => {
    mockGetRedis.mockResolvedValue(undefined);
    await expect(publishUserRevocation('u1')).resolves.toBeUndefined();
    expect(fakeRedis.set).not.toHaveBeenCalled();
    expect(mockUserFindById).not.toHaveBeenCalled(); // short-circuits before the DB read
  });

  it('no-ops when the user is missing', async () => {
    findByIdResolves(null);
    await publishUserRevocation('ghost');
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });

  it('swallows a DB error (best-effort)', async () => {
    mockUserFindById.mockImplementation(() => { throw new Error('mongo down'); });
    await expect(publishUserRevocation('u1')).resolves.toBeUndefined();
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });
});

describe('publishUsersRevocation', () => {
  it('reads all versions in one query and publishes each', async () => {
    findResolves([{ _id: 'u1', tokenVersion: 3 }, { _id: 'u2', tokenVersion: 5 }]);

    await publishUsersRevocation(['u1', 'u2']);

    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(fakeRedis.set).toHaveBeenCalledTimes(2);
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:u1', '3', 'EX', 3600);
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:u2', '5', 'EX', 3600);
  });

  it('accepts ObjectId-like ids (stringifies) and skips versionless docs', async () => {
    findResolves([{ _id: 'u1', tokenVersion: 9 }, { _id: 'u2' /* no tokenVersion */ }]);
    await publishUsersRevocation([{ toString: () => 'u1' }, { toString: () => 'u2' }]);
    expect(fakeRedis.set).toHaveBeenCalledTimes(1);
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:u1', '9', 'EX', 3600);
  });

  it('no-ops on an empty batch (no Redis / DB access)', async () => {
    await publishUsersRevocation([]);
    expect(mockGetRedis).not.toHaveBeenCalled();
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });
});
