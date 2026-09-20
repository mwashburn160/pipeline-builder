// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the TOTP enrolment, run against an actual collection
 * rather than the in-memory stand-in `totp-service.test.ts` uses.
 *
 * What only a real database can tell us:
 *   - the `select: false` projections actually hide the secret and the recovery
 *     hashes from an ordinary read (a stand-in returns whatever it was handed);
 *   - the `userId` unique index really is one enrolment per account;
 *   - the positional `recoveryCodes.$` spend and the conditional `lastUsedStep`
 *     claim behave as Mongo (not as our approximation of Mongo) under
 *     CONCURRENT use — which is exactly where a replay would slip through;
 *   - the user cascade takes the enrolment with it.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * user-cascade.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('TOTP enrolment (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, totp: any, errors: any, utils: any, secretBlob: any, userProfileService: any;

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.UserTotp, m.MfaRecoveryCodes, m.UserOrganization, m.Role, m.RoleAssignment, m.JoinRequest, m.PersonalAccessToken, m.UserPreferences, m.Organization, m.WebAuthnCredential]) {
      await model.createCollection().catch(() => undefined);
    }
    await m.UserTotp.syncIndexes();
    totp = await import('../src/services/totp-service.js');
    errors = await import('../src/services/totp-errors.js');
    utils = await import('../src/utils/totp.js');
    secretBlob = await import('../src/utils/secret-blob.js');
    ({ userProfileService } = await import('../src/services/user-profile-service.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let userId: string;
  beforeEach(async () => {
    for (const model of [m.User, m.UserTotp, m.MfaRecoveryCodes, m.UserOrganization, m.Role, m.RoleAssignment, m.Organization]) await model.deleteMany({});
    const user = await m.User.create({ username: 'enrollee', email: 'enrollee@acme.com', password: 'Passw0rdPassw0rd', isEmailVerified: true });
    userId = String(user._id);
  });

  /** Enrol + confirm, returning the clear-text secret and the recovery codes. */
  async function enrol(): Promise<{ secret: string; recoveryCodes: string[] }> {
    const { secret } = await totp.beginEnrolment(userId);
    const { recoveryCodes } = await totp.activate(userId, utils.totpCodeForStep(secret, utils.timeStepAt()));
    return { secret, recoveryCodes };
  }

  it('hides the secret and the recovery hashes from an ordinary read', async () => {
    await enrol();
    const plain = await m.UserTotp.findOne({ userId }).lean();
    expect(plain).not.toBeNull();
    // `select: false` — a route that forgets to project can't leak either.
    expect(plain.secret).toBeUndefined();
    expect(plain.recoveryCodes).toBeUndefined();
    expect(plain.activatedAt).toBeInstanceOf(Date);
  });

  it('stores the secret as an encrypted blob bound to the user', async () => {
    const { secret } = await enrol();
    const doc = await m.UserTotp.findOne({ userId }).select('+secret').lean();

    expect(doc.secret).not.toContain(secret);
    expect(JSON.parse(doc.secret).alg).toBe('aes-256-gcm-v1');
    expect(await secretBlob.unwrapEncrypted(doc.secret, `user:${userId}`, 'totp.secret')).toBe(secret);
    await expect(secretBlob.unwrapEncrypted(doc.secret, `user:${String(new mongoose.Types.ObjectId())}`, 'totp.secret'))
      .rejects.toThrow();
  });

  it('keeps exactly one enrolment per account (unique index)', async () => {
    await enrol();
    await expect(m.UserTotp.create({ userId, secret: 'x', recoveryCodes: [] })).rejects.toThrow();
    expect(await m.UserTotp.countDocuments({ userId })).toBe(1);
  });

  it('spends a recovery code exactly once under CONCURRENT use', async () => {
    const { recoveryCodes } = await enrol();
    // Both requests race on the same array element; the positional update means
    // only one can stamp it.
    const results = await Promise.allSettled([
      totp.verifyCode(userId, recoveryCodes[0]),
      totp.verifyCode(userId, recoveryCodes[0]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // One set per account, in its own collection (shared with passkeys).
    const doc = await m.MfaRecoveryCodes.findOne({ userId }).select('+codes').lean();
    expect(doc.codes.filter((c: { usedAt?: Date }) => c.usedAt)).toHaveLength(1);
  });

  it('honours a generated code exactly once under CONCURRENT use', async () => {
    const { secret } = await enrol();
    // Activation consumed the current step; the next one is live.
    const code = utils.totpCodeForStep(secret, utils.timeStepAt() + 1);
    const results = await Promise.allSettled([
      totp.verifyCode(userId, code),
      totp.verifyCode(userId, code),
    ]);
    // The conditional `lastUsedStep` claim is what makes the loser a replay.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const doc = await m.UserTotp.findOne({ userId }).lean();
    expect(doc.lastUsedStep).toBe(utils.timeStepAt() + 1);
  });

  it('refuses a code whose step was already spent', async () => {
    const { secret } = await enrol();
    const code = utils.totpCodeForStep(secret, utils.timeStepAt() + 1);
    await totp.verifyCode(userId, code);
    await expect(totp.verifyCode(userId, code)).rejects.toThrow(errors.TOTP_INVALID_CODE);
  });

  it('goes with the user when the account is deleted', async () => {
    await enrol();
    await userProfileService.deleteAccount(userId);
    expect(await m.UserTotp.countDocuments({ userId })).toBe(0);
  });

  it('reports itself through authFactors.hasTotp only once confirmed', async () => {
    const { loadFactorUser, resolveAuthFactors } = await import('../src/helpers/auth-factors.js');

    await totp.beginEnrolment(userId);
    const pending = await resolveAuthFactors((await loadFactorUser(userId))!);
    expect(pending.hasTotp).toBe(false);

    const { secret } = await totp.beginEnrolment(userId);
    await totp.activate(userId, utils.totpCodeForStep(secret, utils.timeStepAt()));
    const active = await resolveAuthFactors((await loadFactorUser(userId))!);
    expect(active.hasTotp).toBe(true);
    expect(active.hasPassword).toBe(true);
  });
});
