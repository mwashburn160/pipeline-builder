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
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/** Fake ioredis-shaped client capturing SETs. */
const fakeRedis = {
  set: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => 'OK'),
  get: jest.fn<AnyFn>(),
  del: jest.fn<AnyFn>(),
  keys: jest.fn<AnyFn>(),
};
const mockGetRedis = jest.fn<(..._a: unknown[]) => Promise<unknown>>(async () => fakeRedis);
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFind = jest.fn<(...a: unknown[]) => unknown>();
const mockImpFind = jest.fn<(...a: unknown[]) => unknown>();
const mockImpUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRecordAudit = jest.fn<(...a: unknown[]) => void>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // Faithful to api-core: SET authrev:tv:<userId> <version> EX <ttl>.
  publishTokenRevocation: async (redis: { set: (...a: unknown[]) => Promise<unknown> }, userId: string, version: number, ttl: number) => {
    await redis.set(`authrev:tv:${userId}`, String(version), 'EX', ttl);
  },
  // Faithful to api-core: SET revoke:<kind>:<id> 1 EX <ttl>, reporting success.
  publishCredentialRevocation: async (redis: { set: (...a: unknown[]) => Promise<unknown> }, kind: string, id: string, ttl: number) => {
    try { await redis.set(`revoke:${kind}:${id}`, '1', 'EX', Math.max(1, Math.ceil(ttl))); return true; } catch { return false; }
  },
  // Faithful to api-core: SET authrev:jti:<jti> 1 PX <ttl>, reporting success.
  publishSessionRevocation: async (redis: { set: (...a: unknown[]) => Promise<unknown> }, jti: string, ttlMs: number) => {
    try { await redis.set(`authrev:jti:${jti}`, '1', 'PX', Math.max(1000, Math.ceil(ttlMs))); return true; } catch { return false; }
  },
}));

// TTL ceiling 3600, base 900, one tier override 1800 → effective max = 3600.
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    jwt: { expiresIn: 900, tierExpiresIn: { developer: undefined, enterprise: 1800 } },
    sessionRevocationTtlSeconds: 3600,
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

jest.unstable_mockModule('../src/models/impersonation-request.js', () => ({
  __esModule: true,
  default: {
    find: (...a: unknown[]) => mockImpFind(...a),
    updateOne: (...a: unknown[]) => mockImpUpdateOne(...a),
  },
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  recordAuditEvent: (...a: unknown[]) => mockRecordAudit(...a),
}));

const {
  publishUserRevocation, publishUsersRevocation, publishImpersonationSessionRevocation, publishUserDeletionRevocation,
  endOperatorImpersonationSessions,
  publishSessionSlotRevocation, publishAccessKeyRevocation, revocationTtlSeconds,
} = await import('../src/helpers/session-revocation.js');

/** User.findById(id).select('+tokenVersion').lean() → doc */
const findByIdResolves = (doc: unknown) =>
  mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(doc) }) });
/** User.find({...}).select('+tokenVersion').lean() → rows */
const findResolves = (rows: unknown[]) =>
  mockUserFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });

/** ImpersonationRequest.find({...}).select(...).lean() → rows */
const impFindResolves = (rows: unknown[]) =>
  mockImpFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRedis.mockResolvedValue(fakeRedis);
  // No live impersonation sessions unless a test seeds some.
  impFindResolves([]);
  mockImpUpdateOne.mockResolvedValue({ modifiedCount: 1 });
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


describe('publishImpersonationSessionRevocation', () => {
  beforeEach(() => {
    (fakeRedis.set as jest.Mock<AnyFn>).mockReset();
    mockGetRedis.mockReset().mockResolvedValue(fakeRedis);
  });

  it('publishes with the time LEFT on the session, and reports it landed', async () => {
    const consumedAt = new Date(Date.now() - 5 * 60_000); // 5 of 15 minutes used
    await expect(publishImpersonationSessionRevocation('sess-1', consumedAt)).resolves.toBe(true);

    const [key, , mode, ttl] = (fakeRedis.set as jest.Mock<AnyFn>).mock.calls[0] as [string, string, string, number];
    expect(key).toBe('authrev:jti:sess-1');
    expect(mode).toBe('PX');
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it('reports success without writing when the token has already expired', async () => {
    const consumedAt = new Date(Date.now() - 20 * 60_000);
    await expect(publishImpersonationSessionRevocation('sess-1', consumedAt)).resolves.toBe(true);
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });

  it('reports FAILURE when no Redis is configured — other services will still accept the token', async () => {
    mockGetRedis.mockResolvedValue(undefined);
    await expect(publishImpersonationSessionRevocation('sess-1', new Date())).resolves.toBe(false);
  });

  it('reports FAILURE when the write fails', async () => {
    (fakeRedis.set as jest.Mock<AnyFn>).mockImplementation(async () => { throw new Error('down'); });
    await expect(publishImpersonationSessionRevocation('sess-1', new Date())).resolves.toBe(false);
  });
});

describe('revocationTtlSeconds', () => {
  it('covers every issuable access-token lifetime (session, key exchange, impersonation)', async () => {
    // ceiling 3600 > base 900, tier 1800, api-key 300, impersonation 900.
    await expect(revocationTtlSeconds()).resolves.toBe(3600);
  });
});

describe('single-credential revocation (revoke:sid / revoke:key)', () => {
  beforeEach(() => { fakeRedis.set.mockReset().mockImplementation(async () => 'OK'); });

  it('publishes revoke:sid:<sid> with the revocation TTL', async () => {
    await expect(publishSessionSlotRevocation('slot-1')).resolves.toBe(true);
    expect(fakeRedis.set).toHaveBeenCalledWith('revoke:sid:slot-1', '1', 'EX', 3600);
  });

  it('publishes revoke:key:<keyId> for every id given', async () => {
    await expect(publishAccessKeyRevocation(['k1', 'k2'])).resolves.toBe(true);
    expect(fakeRedis.set).toHaveBeenCalledWith('revoke:key:k1', '1', 'EX', 3600);
    expect(fakeRedis.set).toHaveBeenCalledWith('revoke:key:k2', '1', 'EX', 3600);
  });

  it('reports false (never throws) when Redis is unavailable or the write fails', async () => {
    mockGetRedis.mockResolvedValue(undefined);
    await expect(publishSessionSlotRevocation('slot-1')).resolves.toBe(false);
    mockGetRedis.mockResolvedValue(fakeRedis);
    fakeRedis.set.mockRejectedValueOnce(new Error('down'));
    await expect(publishAccessKeyRevocation('k1')).resolves.toBe(false);
  });
});

describe('publishUserRevocation — a known (post-$inc) version', () => {
  beforeEach(() => { fakeRedis.set.mockReset().mockImplementation(async () => 'OK'); });

  it('publishes exactly the version the bump returned, without re-reading', async () => {
    await publishUserRevocation('u1', 9);
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:u1', '9', 'EX', 3600);
    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it('re-reads and publishes tokenVersion + claimsVersion when no version is given', async () => {
    findByIdResolves({ _id: 'u1', tokenVersion: 3, claimsVersion: 4 });
    await publishUserRevocation('u1');
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:u1', '7', 'EX', 3600);
  });
});

describe('operator revocation reaches the impersonation sessions they opened', () => {
  beforeEach(() => { fakeRedis.set.mockReset().mockImplementation(async () => 'OK'); });

  const consumedAt = new Date(Date.now() - 60_000);
  /** A live session opened by `op1` against `target`, stamped at tv 5 / cv 2. */
  const session = (over: Record<string, unknown> = {}) => ({
    _id: 'req-1',
    jti: 'sess-1',
    consumedAt,
    requesterId: 'op1',
    targetUserId: 'target',
    organizationId: 'org-a',
    requesterTokenVersion: 5,
    requesterClaimsVersion: 2,
    requesterSuperAdmin: false,
    ...over,
  });
  const jtiWrites = () => fakeRedis.set.mock.calls.filter((c) => String(c[0]).startsWith('authrev:jti:'));

  it('ends a tenant-authority session once the operator\'s claimsVersion moved — by jti, never the subject', async () => {
    findByIdResolves({ _id: 'op1', tokenVersion: 5, claimsVersion: 3 });
    impFindResolves([session()]);
    findResolves([{ _id: 'op1', tokenVersion: 5, claimsVersion: 3 }]);

    await publishUserRevocation('op1');

    // Only LIVE sessions the operator OPENED are considered.
    const filter = mockImpFind.mock.calls[0]![0] as Record<string, any>;
    expect(filter).toMatchObject({ requesterId: { $in: ['op1'] }, status: 'consumed' });
    expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
    // Marked revoked in Mongo, guarded on still being consumed.
    expect(mockImpUpdateOne).toHaveBeenCalledWith(
      { _id: 'req-1', status: 'consumed' },
      { $set: { status: 'revoked', revokedAt: expect.any(Date) } },
    );
    // Published by the session's jti — the impersonated user's own version is
    // never touched, so they stay signed in.
    expect(jtiWrites().map((c) => c[0])).toEqual(['authrev:jti:sess-1']);
    expect(fakeRedis.set).not.toHaveBeenCalledWith('authrev:tv:target', expect.anything(), expect.anything(), expect.anything());
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.impersonate.revoke',
      targetType: 'user',
      targetId: 'target',
      affectedOrgId: 'org-a',
      outcome: 'success',
      details: { impersonationRequestId: 'req-1', requesterId: 'op1', reason: 'operator-revoked', revokedEverywhere: true },
    }));
  });

  it('ends any session once the operator\'s hard tokenVersion moved', async () => {
    impFindResolves([session({ requesterSuperAdmin: true })]);
    findResolves([{ _id: 'op1', tokenVersion: 6, claimsVersion: 2, isSuperAdmin: true }]);
    await publishUserRevocation('op1', 8);
    expect(jtiWrites()).toHaveLength(1);
  });

  it('ends a superadmin session once the flag is gone', async () => {
    impFindResolves([session({ requesterSuperAdmin: true })]);
    findResolves([{ _id: 'op1', tokenVersion: 5, claimsVersion: 2, isSuperAdmin: false }]);
    await expect(endOperatorImpersonationSessions(['op1'])).resolves.toBe(1);
  });

  it('LEAVES a session the operator still supports (superadmin + claims move, or nothing moved)', async () => {
    impFindResolves([
      session({ _id: 'req-sa', jti: 'sess-sa', requesterSuperAdmin: true }),
      session({ _id: 'req-t', jti: 'sess-t' }),
    ]);
    // claimsVersion matches the tenant session's stamp; the superadmin session
    // ignores claims, and the flag is still held.
    findResolves([{ _id: 'op1', tokenVersion: 5, claimsVersion: 2, isSuperAdmin: true }]);
    await expect(endOperatorImpersonationSessions(['op1'])).resolves.toBe(0);
    expect(mockImpUpdateOne).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('a superadmin session survives the operator\'s claimsVersion moving', async () => {
    impFindResolves([session({ requesterSuperAdmin: true })]);
    findResolves([{ _id: 'op1', tokenVersion: 5, claimsVersion: 99, isSuperAdmin: true }]);
    await expect(endOperatorImpersonationSessions(['op1'])).resolves.toBe(0);
  });

  it('ends a session whose operator row is gone', async () => {
    impFindResolves([session()]);
    findResolves([]);
    await expect(endOperatorImpersonationSessions(['op1'])).resolves.toBe(1);
  });

  it('does not publish or audit a session someone else ended first', async () => {
    impFindResolves([session({ requesterTokenVersion: undefined })]);
    findResolves([{ _id: 'op1', tokenVersion: 5, claimsVersion: 2 }]);
    mockImpUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(endOperatorImpersonationSessions(['op1'])).resolves.toBe(0);
    expect(jtiWrites()).toHaveLength(0);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('a record without a jti or org still ends and audits (nothing to publish)', async () => {
    impFindResolves([session({ jti: undefined, organizationId: undefined })]);
    findResolves([]);
    mockImpUpdateOne.mockResolvedValue({});
    await expect(endOperatorImpersonationSessions(['op1'])).resolves.toBe(0);
    mockImpUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    await expect(endOperatorImpersonationSessions(['op1'])).resolves.toBe(1);
    expect(jtiWrites()).toHaveLength(0);
    const event = mockRecordAudit.mock.calls[0]![0] as Record<string, unknown>;
    expect(event).not.toHaveProperty('affectedOrgId');
    expect(event.details).toMatchObject({ revokedEverywhere: true });
  });

  it('a deleted operator\'s sessions all end, without reading the operator', async () => {
    impFindResolves([session()]);
    await publishUserDeletionRevocation('op1', 7);
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:op1', '8', 'EX', 3600);
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(jtiWrites()).toHaveLength(1);
  });

  it('the batch publisher sweeps every bumped user\'s sessions', async () => {
    findResolves([{ _id: 'op1', tokenVersion: 5, claimsVersion: 3 }, { _id: 'u2', tokenVersion: 1 }]);
    impFindResolves([session()]);
    await publishUsersRevocation(['op1', 'u2']);
    expect((mockImpFind.mock.calls[0]![0] as any).requesterId).toEqual({ $in: ['op1', 'u2'] });
    expect(jtiWrites()).toHaveLength(1);
  });

  it('no-ops on an empty operator list, and swallows a sweep failure in the publisher', async () => {
    await expect(endOperatorImpersonationSessions([])).resolves.toBe(0);
    expect(mockImpFind).not.toHaveBeenCalled();

    findByIdResolves({ _id: 'op1', tokenVersion: 5 });
    mockImpFind.mockImplementation(() => { throw new Error('mongo down'); });
    await expect(publishUserRevocation('op1')).resolves.toBeUndefined();
    // The user's own version still landed first.
    expect(fakeRedis.set).toHaveBeenCalledWith('authrev:tv:op1', '5', 'EX', 3600);
  });
});
