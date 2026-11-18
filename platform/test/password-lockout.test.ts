// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit view of the durable password lockout (helpers/password-lockout.ts) over
 * the shared attempt-lockout core: the upserted, TTL-stamped counter, the lock
 * at `maxFailures` (audited as `user.login.locked_out`), the typed refusal, and
 * a clear that never lifts a live lock. Real-Mongo behaviour (atomicity, the
 * TTL index) is in password-lockout.integration.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let doc: any = null;
const mockFindOneAndUpdate = jest.fn((_f: unknown, update: any, opts: any) => ({
  lean: async () => {
    if (!doc && !opts.upsert) return null;
    doc ??= { failedAttempts: 0, lockedUntil: null };
    doc.failedAttempts += update.$inc.failedAttempts;
    if (update.$set) Object.assign(doc, update.$set);
    for (const [k, v] of Object.entries((update.$max ?? {}) as Record<string, Date>)) {
      if (!doc[k] || doc[k] < v) doc[k] = v;
    }
    return { failedAttempts: doc.failedAttempts };
  },
}));
const mockUpdateOne = jest.fn(async (_f: unknown, update: any) => { Object.assign(doc, update.$set); });
const mockDeleteOne = jest.fn(async (_f: unknown) => ({ deletedCount: 1 }));
const mockRecordAudit = jest.fn();

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: { passwordLockout: { maxFailures: 2, lockoutMs: 60_000, windowMs: 30_000 } },
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  PasswordLoginLockout: {
    findOne: () => ({ select: () => ({ lean: async () => doc }) }),
    findOneAndUpdate: mockFindOneAndUpdate,
    updateOne: mockUpdateOne,
    deleteOne: mockDeleteOne,
  },
  User: { findById: () => ({ select: () => ({ lean: async () => ({ lastActiveOrgId: 'org-1' }) }) }) },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: (...a: unknown[]) => mockRecordAudit(...a) }));

const lockout = await import('../src/helpers/password-lockout.js');

beforeEach(() => { doc = null; jest.clearAllMocks(); });

describe('password lockout', () => {
  it('upserts the counter and stamps the TTL window on the first failure', async () => {
    const before = Date.now();
    await lockout.recordPasswordFailure('u1');
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1' },
      expect.objectContaining({ $inc: { failedAttempts: 1 }, $max: { expiresAt: expect.any(Date) } }),
      expect.objectContaining({ upsert: true }),
    );
    expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    await expect(lockout.assertPasswordNotLocked('u1')).resolves.toBeUndefined();
  });

  it('locks at maxFailures, aligns the TTL with the lock, and audits user.login.locked_out', async () => {
    await lockout.recordPasswordFailure('u1');
    await lockout.recordPasswordFailure('u1');
    expect(doc.failedAttempts).toBe(0);
    expect(doc.expiresAt).toEqual(doc.lockedUntil);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.login.locked_out',
      targetId: 'u1',
      orgId: 'org-1',
      details: expect.objectContaining({ factor: 'password', failures: 2 }),
    }));

    const err = await lockout.assertPasswordNotLocked('u1').catch((e: unknown) => e) as InstanceType<typeof lockout.PasswordLockedOutError>;
    expect(err).toBeInstanceOf(lockout.PasswordLockedOutError);
    expect(err.message).toBe(lockout.PASSWORD_LOCKED_OUT);
    expect(err.retryAfterSeconds).toBeGreaterThan(55);
  });

  it('a failure that raced past the lock check never shortens the lock\'s TTL (window < lockout)', async () => {
    await lockout.recordPasswordFailure('u1');
    await lockout.recordPasswordFailure('u1');
    const lockedUntil = doc.lockedUntil as Date;
    // A request that read the run before the lock landed counts its failure now.
    await lockout.recordPasswordFailure('u1');
    expect(doc.expiresAt).toEqual(lockedUntil);
    await expect(lockout.assertPasswordNotLocked('u1')).rejects.toBeInstanceOf(lockout.PasswordLockedOutError);
  });

  it('an expired lock no longer refuses; retryAfterSeconds never drops below 1', async () => {
    doc = { failedAttempts: 0, lockedUntil: new Date(Date.now() - 5) };
    await expect(lockout.assertPasswordNotLocked('u1')).resolves.toBeUndefined();
    expect(new lockout.PasswordLockedOutError(new Date(Date.now() - 1000)).retryAfterSeconds).toBe(1);
  });

  it('clearing only removes a NOT-locked run', async () => {
    await lockout.clearPasswordFailures('u1');
    expect(mockDeleteOne).toHaveBeenCalledWith({
      userId: 'u1',
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: expect.any(Date) } }],
    });
  });
});
