// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session lifetime at renewal (services/session/refresh-sessions.ts): an
 * interactive slot past its maximum age or idle timeout renews nothing
 * (`SESSION_EXPIRED`) and is dropped; switch-org refuses without dropping; a
 * machine slot is never idle-timed but ends at its fixed `expiresAt`; a slot
 * left at an old tokenVersion is dead. Slots live in the in-memory store fake —
 * the real collection is exercised by refresh-sessions.integration.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    passwordMinLength: 8,
    jwt: { secret: 'test-jwt-secret', expiresIn: 900, algorithm: 'HS256', saltRounds: 12 },
    refreshToken: { secret: 'x', expiresIn: 2592000 },
    session: { maxAgeDays: 30, idleTimeoutDays: 7 },
  },
}));

const emptyFindChain = () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) });
const mockPublishSlot = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: (...a: unknown[]) => mockPublishSlot(...a),
}));
const { sessionStoreFake } = await import('./helpers/session-store-fake.js');
const store = sessionStoreFake();
jest.unstable_mockModule('../src/services/session/session-store.js', () => store);
jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn<AnyFn>().mockResolvedValue({}), findById: jest.fn() },
  Organization: {},
  UserOrganization: {},
  Role: { find: jest.fn(emptyFindChain) },
  RoleAssignment: { find: jest.fn(emptyFindChain) },
}));

const { renewSessionTokens, switchSessionOrg, hashRefreshToken } = await import('../src/services/session/refresh-sessions.js');
(await import('./helpers/signing.js')).installTestSigningKeys();

const DAY = 86400_000;
const user = { _id: { toString: () => 'u1' }, username: 'u', email: 'u@x.test', isEmailVerified: true, tokenVersion: 2 } as any;

function seed(over: Record<string, unknown> = {}) {
  store.rows.push({
    userId: 'u1',
    id: 's1',
    kind: 'interactive',
    tokenVersion: 2,
    hash: hashRefreshToken('rt'),
    createdAt: new Date(),
    lastUsedAt: new Date(),
    authTime: new Date(),
    amr: ['pwd'],
    aal: 1,
    purgeAt: new Date(Date.now() + DAY),
    ...over,
  });
}

beforeEach(() => {
  store.reset();
  mockPublishSlot.mockClear();
});

describe('renewSessionTokens — interactive lifetime', () => {
  it('renews inside both bounds, recording the use and a new purge time', async () => {
    seed({ authTime: new Date(Date.now() - 10 * DAY), lastUsedAt: new Date(Date.now() - DAY) });
    const tokens = await renewSessionTokens(user, undefined, { sessionId: 's1', presentedToken: 'rt', kind: 'interactive' });
    expect(tokens).not.toBeNull();
    expect(store.rows[0].hash).toBe(hashRefreshToken(tokens!.refreshToken));
    expect(Date.now() - new Date(store.rows[0].lastUsedAt).getTime()).toBeLessThan(5000);
    expect(store.rows[0].purgeAt).toBeInstanceOf(Date);
  });

  it.each([
    ['idle past the timeout', 10, 8],
    ['past the maximum age', 31, 0],
  ])('%s → SESSION_EXPIRED, slot dropped and its sid revoked', async (_l, signedIn, used) => {
    seed({ authTime: new Date(Date.now() - signedIn * DAY), lastUsedAt: new Date(Date.now() - used * DAY) });
    await expect(renewSessionTokens(user, undefined, { sessionId: 's1', presentedToken: 'rt', kind: 'interactive' }))
      .rejects.toThrow('SESSION_EXPIRED');
    expect(store.rows).toHaveLength(0);
    expect(mockPublishSlot).toHaveBeenCalledWith('s1');
  });

  it('a slot at an old tokenVersion renews nothing (and is not reported as expired)', async () => {
    seed({ tokenVersion: 1 });
    await expect(renewSessionTokens(user, undefined, { sessionId: 's1', presentedToken: 'rt', kind: 'interactive' })).resolves.toBeNull();
  });

  it('a rotated-away token (hash mismatch) is a miss, not an expiry', async () => {
    seed({ hash: 'other' });
    await expect(renewSessionTokens(user, undefined, { sessionId: 's1', presentedToken: 'rt', kind: 'interactive' })).resolves.toBeNull();
    expect(store.rows).toHaveLength(1);
  });
});

describe('renewSessionTokens — machine slots', () => {
  it('are never idle-timed', async () => {
    seed({ kind: 'machine', authTime: new Date(Date.now() - 200 * DAY), lastUsedAt: new Date(Date.now() - 60 * DAY), expiresAt: new Date(Date.now() + DAY) });
    await expect(renewSessionTokens(user, undefined, { sessionId: 's1', kind: 'machine' })).resolves.not.toBeNull();
  });

  it('end at their fixed expiresAt → SESSION_EXPIRED and dropped', async () => {
    seed({ kind: 'machine', expiresAt: new Date(Date.now() - 1000) });
    await expect(renewSessionTokens(user, undefined, { sessionId: 's1', kind: 'machine' })).rejects.toThrow('SESSION_EXPIRED');
    expect(store.rows).toHaveLength(0);
  });
});

describe('switchSessionOrg — lifetime', () => {
  it('reports session-expired WITHOUT dropping the slot (it is still valid where it is)', async () => {
    seed({ authTime: new Date(Date.now() - 31 * DAY) });
    await expect(switchSessionOrg(user, 'org-x', 's1')).resolves.toBe('session-expired');
    expect(store.rows).toHaveLength(1);
    expect(mockPublishSlot).not.toHaveBeenCalled();
  });

  it('is session-invalid for a missing slot', async () => {
    await expect(switchSessionOrg(user, 'org-x', 'nope')).resolves.toBe('session-invalid');
  });
});
