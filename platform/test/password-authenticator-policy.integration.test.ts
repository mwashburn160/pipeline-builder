// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo checks for the org password policy on every path that SETS a
 * password, and for the org authenticator allowlist at the token-issuance
 * chokepoint:
 *   - password change and admin reset answer to the strictest org minimum
 *     among the person's orgs (a parent org's minimum reaches its teams);
 *   - a passkey session whose model an org does not allowlist is issued at
 *     `aal: 2` elsewhere but `aal: 1` in that org — at sign-in AND on
 *     switch-org/renewal, because the model rides on the session slot.
 *
 * The breached-password check is turned off (no egress from the suite); it has
 * its own unit suite. Gated behind RUN_MONGO_INTEGRATION=1, like the siblings.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Registry } from 'prom-client';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.PASSWORD_BREACH_CHECK = 'off';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

const YUBIKEY = 'cb69481e-8ff7-4039-93ec-0a2729a154a8';
const ICLOUD = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

suite('org password + authenticator policy (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, token: any, userProfileService: any, userAdminService: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    // A replica set: the admin-reset path runs in a transaction.
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    token = {
      ...(await import('../src/services/session/membership-context.js')),
      ...(await import('../src/services/session/access-tokens.js')),
      ...(await import('../src/services/session/refresh-sessions.js')),
      ...(await import('../src/utils/token.js')),
    };
    ({ userProfileService } = await import('../src/services/user-profile-service.js'));
    ({ userAdminService } = await import('../src/services/user-admin-service.js'));
    (await import('./helpers/signing.js')).installTestSigningKeys();
    (await import('../src/observability/metrics.js')).setMetricsRegistry(new Registry());
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let userId: string;
  let rootId: string;
  let teamId: string;
  let otherId: string;

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization]) await model.deleteMany({});
    const owner = new mongoose.Types.ObjectId();
    const root = await m.Organization.create({ name: 'Root', owner, tier: 'team', passwordMinLength: 16, allowedAuthenticatorAaguids: [YUBIKEY] });
    const team = await m.Organization.create({ name: 'Team', owner, tier: 'team', parentOrgId: String(root._id) });
    const other = await m.Organization.create({ name: 'Other', owner, tier: 'pro' });
    rootId = String(root._id); teamId = String(team._id); otherId = String(other._id);
    const user = await m.User.create({
      username: 'member', email: 'member@example.com', password: 'Passw0rdShort', isEmailVerified: true, lastActiveOrgId: other._id,
    });
    userId = String(user._id);
    await m.UserOrganization.create({ userId: user._id, organizationId: team._id, role: 'member', isActive: true });
    await m.UserOrganization.create({ userId: user._id, organizationId: other._id, role: 'member', isActive: true });
  });

  describe('password policy on every path that sets a password', () => {
    it('a password change answers to the strictest org the person belongs to (inherited from the team\'s parent)', async () => {
      await expect(userProfileService.changePassword(userId, 'Passw0rdShort', 'Fifteen1Chars!!'))
        .rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT_FOR_ORG', statusCode: 400 });
      await expect(userProfileService.changePassword(userId, 'Passw0rdShort', 'Sixteen1Chars!!!')).resolves.toBeUndefined();
    });

    it('an admin reset is held to the same bar', async () => {
      const opts = { actor: { isSuperAdmin: true, isOrgAdmin: false, permissions: [] }, passwordMinLength: 8 };
      await expect(userAdminService.updateUserById(userId, { password: 'Fifteen1Chars!!' }, opts))
        .rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT_FOR_ORG' });
      await expect(userAdminService.updateUserById(userId, { password: 'Sixteen1Chars!!!' }, opts)).resolves.toBeTruthy();
    });

    it('the existing (shorter) password is flagged at sign-in time, not silently accepted', async () => {
      const { passwordShortfall } = await import('../src/helpers/password-policy.js');
      expect(await passwordShortfall('Passw0rdShort', userId)).toEqual({ minLength: 16, orgId: teamId });
    });
  });

  describe('authenticator allowlist at issuance', () => {
    const passkey = (aaguid: string) => ({ amr: ['webauthn'], aal: 2, authTime: new Date(), aaguid });

    it('a non-allowlisted passkey is aal 2 in an org with no list, aal 1 where the (inherited) list excludes it', async () => {
      const user = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin');
      const elsewhere = await token.issueTokens(user, otherId, { kind: 'interactive', auth: passkey(ICLOUD) });
      expect(token.verifyAccessToken(elsewhere.accessToken).aal).toBe(2);

      const inTeam = await token.issueTokens(user, teamId, { kind: 'interactive', auth: passkey(ICLOUD) });
      expect(token.verifyAccessToken(inTeam.accessToken).aal).toBe(1);

      const allowed = await token.issueTokens(user, teamId, { kind: 'interactive', auth: passkey(YUBIKEY) });
      expect(token.verifyAccessToken(allowed.accessToken).aal).toBe(2);
    });

    it('the model rides on the slot, so switching INTO the org re-applies the list', async () => {
      const user = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin');
      const issued = await token.issueTokens(user, otherId, { kind: 'interactive', auth: passkey(ICLOUD) });
      const sid = token.verifyAccessToken(issued.accessToken).sid;
      const switched = await token.renewSessionTokens(user, teamId, { sessionId: sid });
      expect(token.verifyAccessToken(switched.accessToken).aal).toBe(1);
    });

    it('where the org ENFORCES MFA, a non-allowlisted passkey opens no session there', async () => {
      await m.Organization.updateOne({ _id: rootId }, { $set: { requireMfa: true } });
      const user = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin');
      const { MFA_REQUIRED_FOR_ORG } = await import('../src/services/auth-errors.js');
      await expect(token.issueTokens(user, teamId, { kind: 'interactive', auth: passkey(ICLOUD) })).rejects.toThrow(MFA_REQUIRED_FOR_ORG);
      await expect(token.issueTokens(user, teamId, { kind: 'interactive', auth: passkey(YUBIKEY) })).resolves.toBeTruthy();
    });
  });
});
