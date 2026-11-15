// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for what `PATCH /user/profile` treats as an email CHANGE —
 * the edit the route step-up gates and the old address is told about:
 *   - `isEmailChange` compares against the STORED address, normalized, and
 *     fails closed for a user that is gone;
 *   - `updateProfile` reports `previousEmail` only for a real change, and
 *     re-sending the current address touches nothing (verification included);
 *   - a change voids an outstanding verification link (it proved the OLD address).
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * access-keys.integration.test.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('profile email change (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, userProfileService: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    ({ userProfileService } = await import('../src/services/user-profile-service.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let userId: string;

  beforeEach(async () => {
    await m.User.deleteMany({});
    const user = await m.User.create({
      username: 'owner', email: 'owner@example.com', password: 'Passw0rd!secret', isEmailVerified: true,
    });
    userId = String(user._id);
  });

  it('isEmailChange: a different address is a change; the stored one (any case/whitespace) is not', async () => {
    await expect(userProfileService.isEmailChange(userId, 'attacker@example.com')).resolves.toBe(true);
    await expect(userProfileService.isEmailChange(userId, '  Owner@Example.COM ')).resolves.toBe(false);
  });

  it('isEmailChange fails closed for a user that is gone', async () => {
    await expect(userProfileService.isEmailChange(String(new mongoose.Types.ObjectId()), 'x@example.com')).resolves.toBe(true);
  });

  it('updateProfile reports the previous address and clears verification on a change', async () => {
    const r = await userProfileService.updateProfile(userId, { email: 'new@example.com' });
    expect(r.previousEmail).toBe('owner@example.com');
    expect(r.user.email).toBe('new@example.com');
    expect(r.user.isEmailVerified).toBe(false);
  });

  it('a verification link mailed to the OLD address cannot verify the NEW one', async () => {
    // An unverified account requests a link (to an address its owner controls),
    // then changes the email to one it does not — the link must die with it.
    await m.User.updateOne({ _id: userId }, { $set: { isEmailVerified: false } });
    const { authService } = await import('../src/services/auth-service.js');
    const dispatch = await authService.createVerificationToken(userId);
    expect(dispatch?.alreadyVerified).toBe(false);

    await userProfileService.updateProfile(userId, { email: 'someone@bigcorp.example' });

    await expect(authService.verifyEmailWithToken(dispatch!.rawToken)).resolves.toBeNull();
    const after = await m.User.findById(userId).select('+emailVerificationToken').lean();
    expect(after.isEmailVerified).toBe(false);
    expect(after.emailVerificationToken).toBeUndefined();
  });

  it('updateProfile treats re-sending the current address as no change', async () => {
    const r = await userProfileService.updateProfile(userId, { email: 'OWNER@example.com', username: 'renamed' });
    expect(r.previousEmail).toBeUndefined();
    expect(r.user.username).toBe('renamed');
    expect(r.user.isEmailVerified).toBe(true);
  });
});
