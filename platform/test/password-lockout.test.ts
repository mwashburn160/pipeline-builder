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
let reserveError: unknown = null;
const mockFindOneAndUpdate = jest.fn((_f: unknown, update: any, opts: any) => ({
  lean: async () => {
    if (Array.isArray(update)) {
      // The reservation pipeline: the update's own literals carry `now`, the
      // limit, and the new reservation, so simulate it from them.
      if (reserveError) { const e = reserveError; reserveError = null; throw e; }
      expect(opts).toMatchObject({ upsert: true, updatePipeline: true });
      const now: Date = update[0].$set.reservations.$filter.cond.$gt[1];
      const max: number = update[1].$set.reservations.$cond[0].$and[1].$lt[1];
      const [mine] = update[1].$set.reservations.$cond[1].$concatArrays[1];
      doc ??= { failedAttempts: 0, lockedUntil: null };
      doc.reservations = (doc.reservations ?? []).filter((r: any) => r.exp > now);
      const locked = doc.lockedUntil && doc.lockedUntil > now;
      if (!locked && doc.failedAttempts + doc.reservations.length < max) doc.reservations.push(mine);
      return { lockedUntil: doc.lockedUntil, reservations: [...doc.reservations] };
    }
    if (!doc && !opts.upsert) return null;
    doc ??= { failedAttempts: 0, lockedUntil: null };
    doc.failedAttempts += update.$inc.failedAttempts;
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$pull) doc.reservations = (doc.reservations ?? []).filter((r: any) => r.id !== update.$pull.reservations.id);
    for (const [k, v] of Object.entries((update.$max ?? {}) as Record<string, Date>)) {
      if (!doc[k] || doc[k] < v) doc[k] = v;
    }
    return { failedAttempts: doc.failedAttempts };
  },
}));
const mockUpdateOne = jest.fn(async (_f: unknown, update: any) => {
  if (!doc) return;
  if (update.$pull) doc.reservations = (doc.reservations ?? []).filter((r: any) => r.id !== update.$pull.reservations.id);
  if (update.$set) Object.assign(doc, update.$set);
});
let deletedCount = 1;
const mockDeleteOne = jest.fn(async (_f: unknown) => ({ deletedCount }));
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

beforeEach(() => { doc = null; deletedCount = 1; reserveError = null; jest.clearAllMocks(); });

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

describe('password attempt reservations', () => {
  it('grants at most maxFailures reservations, then refuses with a short Retry-After', async () => {
    const a = await lockout.reservePasswordAttempt('u1');
    const b = await lockout.reservePasswordAttempt('u1');
    expect(a.reservationId).not.toBe(b.reservationId);
    const err = await lockout.reservePasswordAttempt('u1').catch((e: unknown) => e) as InstanceType<typeof lockout.PasswordLockedOutError>;
    expect(err).toBeInstanceOf(lockout.PasswordLockedOutError);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(lockout.PASSWORD_ATTEMPT_RESERVATION_MS / 1000));
  });

  it('a failure converts its reservation (pulled in the same update as the increment)', async () => {
    const a = await lockout.reservePasswordAttempt('u1');
    await lockout.recordPasswordFailure('u1', a.reservationId);
    expect(mockFindOneAndUpdate).toHaveBeenLastCalledWith(
      { userId: 'u1' },
      expect.objectContaining({ $inc: { failedAttempts: 1 }, $pull: { reservations: { id: a.reservationId } } }),
      expect.anything(),
    );
    expect(doc.reservations).toEqual([]);
    expect(doc.failedAttempts).toBe(1);
    // One failure + nothing in flight: one attempt left.
    await lockout.reservePasswordAttempt('u1');
    await expect(lockout.reservePasswordAttempt('u1')).rejects.toBeInstanceOf(lockout.PasswordLockedOutError);
  });

  it('a live lockout refuses with the lockout\'s own Retry-After', async () => {
    doc = { failedAttempts: 0, lockedUntil: new Date(Date.now() + 60_000), reservations: [] };
    const err = await lockout.reservePasswordAttempt('u1').catch((e: unknown) => e) as InstanceType<typeof lockout.PasswordLockedOutError>;
    expect(err).toBeInstanceOf(lockout.PasswordLockedOutError);
    expect(err.retryAfterSeconds).toBeGreaterThan(55);
  });

  it('an expired reservation (a crashed check) no longer counts', async () => {
    doc = { failedAttempts: 1, lockedUntil: null, reservations: [{ id: 'dead', exp: new Date(Date.now() - 1) }] };
    await expect(lockout.reservePasswordAttempt('u1')).resolves.toMatchObject({ userId: 'u1' });
    expect(doc.reservations.map((r: any) => r.id)).not.toContain('dead');
  });

  it('retries once when a racing first upsert hits the unique index', async () => {
    reserveError = Object.assign(new Error('E11000'), { code: 11000 });
    await expect(lockout.reservePasswordAttempt('u1')).resolves.toMatchObject({ userId: 'u1' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('any other store error propagates', async () => {
    reserveError = new Error('mongo down');
    await expect(lockout.reservePasswordAttempt('u1')).rejects.toThrow('mongo down');
  });

  it('complete: one delete on the common path (not locked, nothing else in flight)', async () => {
    const a = await lockout.reservePasswordAttempt('u1');
    await lockout.completePasswordAttempt(a);
    expect(mockDeleteOne).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      reservations: { $not: { $elemMatch: { id: { $ne: a.reservationId }, exp: { $gt: expect.any(Date) } } } },
    }));
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('complete with other checks in flight: drops only its own reservation and resets the count', async () => {
    deletedCount = 0;
    const a = await lockout.reservePasswordAttempt('u1');
    const b = await lockout.reservePasswordAttempt('u1');
    doc.failedAttempts = 1;
    await lockout.completePasswordAttempt(a);
    expect(doc.reservations.map((r: any) => r.id)).toEqual([b.reservationId]);
    expect(doc.failedAttempts).toBe(0);
  });

  it('complete refuses when a lockout landed mid-check — the right password never lifts it', async () => {
    deletedCount = 0;
    const a = await lockout.reservePasswordAttempt('u1');
    doc.lockedUntil = new Date(Date.now() + 60_000);
    await expect(lockout.completePasswordAttempt(a)).rejects.toBeInstanceOf(lockout.PasswordLockedOutError);
    expect(doc.reservations).toEqual([]);
  });

  it('release pulls just the reservation', async () => {
    const a = await lockout.reservePasswordAttempt('u1');
    await lockout.releasePasswordAttempt(a);
    expect(mockUpdateOne).toHaveBeenCalledWith({ userId: 'u1' }, { $pull: { reservations: { id: a.reservationId } } });
    expect(doc.reservations).toEqual([]);
  });
});
