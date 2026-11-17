// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the DURABLE password lockout (helpers/password-lockout.ts)
 * — the backstop that bounds password guessing when the per-account Redis
 * limiter fails open. Counts only into a real collection: the upserted counter,
 * the lock at `maxFailures`, the TTL stamp, a correct password never lifting a
 * live lock, and a password reset lifting it.
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
});
