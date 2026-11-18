// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo regressions for the `'+tokenVersion …'` projections in
 * services/user-profile-service.ts.
 *
 * `tokenVersion` is NOT `select: false`, so Mongoose kept the `+` as part of a
 * literal field name: `select('+tokenVersion issuedTokens')` projected only
 * `issuedTokens`, and the document came back WITHOUT `tokenVersion`. Against a
 * mocked model the projection string is never evaluated, so only a real query
 * shows the effect:
 *   - token history reported every live token as `revoked`
 *     (`tokenVersionAtIssue !== undefined`);
 *   - "revoke all sessions" returned a document with no identity fields and a
 *     `NaN` tokenVersion (`undefined += 1`), from which the caller mints the
 *     surviving session.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.PASSWORD_BREACH_CHECK = 'off';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('user profile — tokenVersion projections (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, userProfileService: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let userId: string;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    ({ userProfileService } = await import('../src/services/user-profile-service.js'));
    (await import('./helpers/signing.js')).installTestSigningKeys();
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.PersonalAccessToken, m.RefreshSession]) await model.deleteMany({});
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId(), tier: 'pro' });
    const now = Date.now();
    const user = await m.User.create({
      username: 'holder',
      email: 'holder@example.com',
      password: 'Some-Passw0rd!secret',
      isEmailVerified: true,
      lastActiveOrgId: org._id,
      tokenVersion: 5,
      claimsVersion: 2,
      issuedTokens: [
        { id: 'live', createdAt: new Date(now - 1000), expiresAt: new Date(now + 3_600_000), tokenVersionAtIssue: 5 },
        { id: 'old', createdAt: new Date(now - 2000), expiresAt: new Date(now + 3_600_000), tokenVersionAtIssue: 4 },
      ],
    });
    userId = String(user._id);
    await m.UserOrganization.create({ userId: user._id, organizationId: org._id, role: 'owner', isActive: true });
  });

  it('token history reports a token issued at the CURRENT tokenVersion as active, not revoked', async () => {
    const history = await userProfileService.listTokenHistory(userId);
    const byId = Object.fromEntries(history.map((t: { id: string; status: string }) => [t.id, t.status]));
    expect(byId).toEqual({ live: 'active', old: 'revoked' });
  });

  it('revoke-all returns the WHOLE account at the bumped tokenVersion, ready to mint the surviving session', async () => {
    const returned = await userProfileService.revokeAllSessions(userId);
    expect(returned.tokenVersion).toBe(6);
    expect(returned.claimsVersion).toBe(2);
    // Identity fields the replacement session is minted from.
    expect(returned.email).toBe('holder@example.com');
    expect(returned.username).toBe('holder');
    expect(String(returned.lastActiveOrgId)).toMatch(/^[0-9a-f]{24}$/);
    const stored = await m.User.findById(userId).select('tokenVersion').lean();
    expect(stored.tokenVersion).toBe(6);
  });
});
