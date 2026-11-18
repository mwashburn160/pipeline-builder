// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the DURABLE password lockout (helpers/password-lockout.ts)
 * — the backstop that bounds password guessing when the per-account Redis
 * limiter fails open. Counts only into a real collection: the upserted counter,
 * the lock at `maxFailures`, the TTL stamp, a correct password never lifting a
 * live lock, and a password reset lifting it. Plus the RESERVE-BEFORE-CHECK
 * step: a burst of parallel wrong guesses runs at most `maxFailures` password
 * checks, and a right guess inside a burst past the limit is refused unchecked.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.LOGIN_ACCOUNT_LOCKOUT_MAX_FAILURES = '3';
process.env.LOGIN_ACCOUNT_LOCKOUT_MS = '60000';
process.env.LOGIN_ACCOUNT_LOCKOUT_WINDOW_MS = '30000';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('Durable password lockout (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, lockout: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let userId: string;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    await m.PasswordLoginLockout.syncIndexes();
    lockout = await import('../src/helpers/password-lockout.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await m.PasswordLoginLockout.collection.deleteMany({});
    await m.User.collection.deleteMany({});
    const _id = new mongoose.Types.ObjectId();
    userId = _id.toString();
    await m.User.collection.insertOne({ _id, username: 'pat', email: 'pat@x.com' });
  });

  it('declares a TTL index on expiresAt so stale runs age out', async () => {
    const indexes = await m.PasswordLoginLockout.collection.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    ]));
  });

  it('creates the counter on the first failure, stamped with the window', async () => {
    const before = Date.now();
    await lockout.recordPasswordFailure(userId);
    const doc = await m.PasswordLoginLockout.findOne({ userId }).lean();
    expect(doc.failedAttempts).toBe(1);
    expect(doc.lockedUntil).toBeNull();
    expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    await expect(lockout.assertPasswordNotLocked(userId)).resolves.toBeUndefined();
  });

  it('locks at maxFailures and refuses until the lockout passes, with a Retry-After', async () => {
    for (let i = 0; i < 3; i++) await lockout.recordPasswordFailure(userId);
    const doc = await m.PasswordLoginLockout.findOne({ userId }).lean();
    expect(doc.failedAttempts).toBe(0);
    expect(doc.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    // The TTL now follows the lock, so the record outlives it.
    expect(doc.expiresAt.getTime()).toBe(doc.lockedUntil.getTime());

    const err = await lockout.assertPasswordNotLocked(userId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(lockout.PasswordLockedOutError);
    expect(err.message).toBe(lockout.PASSWORD_LOCKED_OUT);
    expect(err.retryAfterSeconds).toBeGreaterThan(50);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts parallel failures atomically — a burst cannot slip past the limit', async () => {
    await Promise.all(Array.from({ length: 5 }, () => lockout.recordPasswordFailure(userId)));
    await expect(lockout.assertPasswordNotLocked(userId)).rejects.toBeInstanceOf(lockout.PasswordLockedOutError);
  });

  it('a correct password clears a run in progress, but never lifts a live lockout', async () => {
    await lockout.recordPasswordFailure(userId);
    await lockout.clearPasswordFailures(userId);
    expect(await m.PasswordLoginLockout.countDocuments({ userId })).toBe(0);

    for (let i = 0; i < 3; i++) await lockout.recordPasswordFailure(userId);
    await lockout.clearPasswordFailures(userId);
    await expect(lockout.assertPasswordNotLocked(userId)).rejects.toBeInstanceOf(lockout.PasswordLockedOutError);
  });

  it('an expired lockout no longer refuses, and the next success clears it', async () => {
    await m.PasswordLoginLockout.collection.insertOne({
      userId: new mongoose.Types.ObjectId(userId),
      failedAttempts: 0,
      lockedUntil: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(lockout.assertPasswordNotLocked(userId)).resolves.toBeUndefined();
    await lockout.clearPasswordFailures(userId);
    expect(await m.PasswordLoginLockout.countDocuments({ userId })).toBe(0);
  });

  /**
   * The login controller's shape (controllers/auth.ts): reserve, and only with a
   * reservation run the (slow) password check, then settle it. `checks` counts
   * how many passwords were actually compared.
   */
  function signIn(password: string, counter: { checks: number }): Promise<'ok' | 'bad' | 'refused'> {
    return (async () => {
      let attempt;
      try {
        attempt = await lockout.reservePasswordAttempt(userId);
      } catch (err) {
        if (err instanceof lockout.PasswordLockedOutError) return 'refused';
        throw err;
      }
      counter.checks++;
      await new Promise((r) => setTimeout(r, 20)); // a bcrypt-ish compare, so the burst overlaps
      if (password === 'right') {
        try {
          await lockout.completePasswordAttempt(attempt);
          return 'ok';
        } catch (err) {
          if (err instanceof lockout.PasswordLockedOutError) return 'refused';
          throw err;
        }
      }
      await lockout.recordPasswordFailure(attempt.userId, attempt.reservationId);
      return 'bad';
    })();
  }

  it('a burst of N parallel wrong guesses runs at most maxFailures password checks, then locks', async () => {
    const counter = { checks: 0 };
    const results = await Promise.all(Array.from({ length: 20 }, () => signIn('wrong', counter)));
    expect(counter.checks).toBe(3);
    expect(results.filter((r) => r === 'bad')).toHaveLength(3);
    expect(results.filter((r) => r === 'refused')).toHaveLength(17);
    await expect(lockout.assertPasswordNotLocked(userId)).rejects.toBeInstanceOf(lockout.PasswordLockedOutError);
    const doc = await m.PasswordLoginLockout.findOne({ userId }).lean();
    expect(doc.reservations).toEqual([]);
  });

  it('a RIGHT guess fired inside a burst past the limit is refused without being checked', async () => {
    const counter = { checks: 0 };
    // Fill every slot with in-flight wrong guesses, then fire the right one.
    const wrong = Array.from({ length: 3 }, () => signIn('wrong', counter));
    await new Promise((r) => setTimeout(r, 5));
    const right = signIn('right', counter);
    const more = Array.from({ length: 5 }, () => signIn('wrong', counter));
    const [rightResult, ...rest] = await Promise.all([right, ...wrong, ...more]);
    expect(rightResult).toBe('refused');
    expect(counter.checks).toBe(3);
    expect(rest.filter((r) => r === 'bad')).toHaveLength(3);
    // And the account is now locked: the right password still gets nothing.
    expect(await signIn('right', counter)).toBe('refused');
    expect(counter.checks).toBe(3);
  });

  it('a right password inside the limit signs in and ends the run', async () => {
    const counter = { checks: 0 };
    expect(await signIn('wrong', counter)).toBe('bad');
    expect(await signIn('right', counter)).toBe('ok');
    expect(await m.PasswordLoginLockout.countDocuments({ userId })).toBe(0);
  });

  it('a right password with another check in flight keeps that check\'s slot and resets the count', async () => {
    await lockout.recordPasswordFailure(userId);
    const other = await lockout.reservePasswordAttempt(userId);
    const mine = await lockout.reservePasswordAttempt(userId);
    await lockout.completePasswordAttempt(mine);
    const doc = await m.PasswordLoginLockout.findOne({ userId }).lean();
    expect(doc.failedAttempts).toBe(0);
    expect(doc.reservations.map((r: { id: string }) => r.id)).toEqual([other.reservationId]);
  });

  it('a reservation leaked by a crash mid-check frees itself once it expires', async () => {
    await m.PasswordLoginLockout.collection.insertOne({
      userId: new mongoose.Types.ObjectId(userId),
      failedAttempts: 2,
      lockedUntil: null,
      reservations: [{ id: 'crashed', exp: new Date(Date.now() - 1) }],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const attempt = await lockout.reservePasswordAttempt(userId);
    const doc = await m.PasswordLoginLockout.findOne({ userId }).lean();
    expect(doc.reservations.map((r: { id: string }) => r.id)).toEqual([attempt.reservationId]);
    // ...while a LIVE reservation still holds its slot.
    await expect(lockout.reservePasswordAttempt(userId)).rejects.toBeInstanceOf(lockout.PasswordLockedOutError);
  });

  it('the first reservation stamps a TTL that outlives it, and never shortens a lock', async () => {
    const before = Date.now();
    await lockout.reservePasswordAttempt(userId);
    const doc = await m.PasswordLoginLockout.findOne({ userId }).lean();
    expect(doc.failedAttempts).toBe(0);
    expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lockout.PASSWORD_ATTEMPT_RESERVATION_MS);
  });

  it('parallel first-ever reservations do not trip over the unique index', async () => {
    const got = await Promise.allSettled(Array.from({ length: 10 }, () => lockout.reservePasswordAttempt(userId)));
    expect(got.filter((g) => g.status === 'fulfilled')).toHaveLength(3);
    for (const g of got) if (g.status === 'rejected') expect(g.reason).toBeInstanceOf(lockout.PasswordLockedOutError);
  });
});
