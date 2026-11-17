// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step-up, end to end through the REAL route table and a real Mongo: the token
 * is EARNED through `/auth/step-up` (password) and `/auth/step-up/totp`
 * (authenticator code against a real enrolment), then SPENT on real gated
 * routes:
 *
 *   - `PATCH /organization/:id/impersonation-policy` — any-factor `requireStepUp`;
 *   - `POST /admin/impersonate/:userId` — `requireStepUp({ methods: STRONG })`.
 *
 * What it proves, each against what actually reaches the database:
 *   - refused without a token, and nothing is written;
 *   - allowed with a fresh one, once — a replay of the same `jti` is refused;
 *   - bound to the caller (another user's token is refused, and NOT burned);
 *   - an access token, an expired token, or a forged one is not a step-up;
 *   - a STRONG-factor route refuses a password step-up without consuming it
 *     (the same token is still good on an any-factor route), and admits a TOTP
 *     one;
 *   - the factor itself is single-use: one TOTP code earns one token.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1.
 */

import { it, expect, beforeAll, afterAll, beforeEach, describe } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const SYSTEM_ORG_ID = '000000000000000000000001';
const PASSWORD = 'Passw0rd!Passw0rd';
const suite = integrationSuite();

suite('step-up flow (real routes, real Mongo)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, harness: any, tokens: any, totp: any, totpUtils: any;
  let call: (method: string, path: string, opts?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let stub: { close: () => Promise<void>; port: number };
  let app: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();

    const { startStubServices } = await import('./helpers/stub-services.js');
    stub = await startStubServices();
    process.env.MESSAGE_SERVICE_HOST = '127.0.0.1';
    process.env.MESSAGE_SERVICE_PORT = String(stub.port);
    process.env.MESSAGE_ENABLED = 'true';
    process.env.QUOTA_SERVICE_HOST = '127.0.0.1';
    process.env.QUOTA_SERVICE_PORT = String(stub.port);

    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.UserOrganization, m.Organization, m.Role, m.RoleAssignment, m.ImpersonationRequest, m.UserTotp, m.MfaRecoveryCodes]) {
      await model.createCollection().catch(() => undefined);
    }
    await m.UserTotp.syncIndexes();
    harness = await import('./helpers/platform-app.js');
    tokens = await import('../src/services/session/access-tokens.js');
    totp = await import('../src/services/totp-service.js');
    totpUtils = await import('../src/utils/totp.js');
    (await import('./helpers/signing.js')).installTestSigningKeys();
    const { Registry } = await import('prom-client');
    (await import('../src/observability/metrics.js')).setMetricsRegistry(new Registry());
    app = await harness.startPlatformApp();
    call = harness.client(app.base);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (stub) await stub.close();
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let acmeId: string;
  let adminId: string;
  let otherAdminId: string;
  let operatorId: string;
  let targetId: string;

  async function member(username: string, orgId: string, role: 'admin' | 'member', permissions: string[] = [], extra: Record<string, unknown> = {}) {
    const user = await m.User.create({
      username, email: `${username}@example.com`, password: PASSWORD, isEmailVerified: true, lastActiveOrgId: orgId, ...extra,
    });
    await m.UserOrganization.create({ userId: user._id, organizationId: orgId, role, isActive: true });
    if (permissions.length > 0) {
      const r = await m.Role.create({ organizationId: orgId, name: `${username}-role`, permissions });
      await m.RoleAssignment.create({ userId: user._id, roleId: r._id, organizationId: orgId });
    }
    return String(user._id);
  }

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.Role, m.RoleAssignment, m.ImpersonationRequest, m.UserTotp, m.MfaRecoveryCodes]) {
      await model.deleteMany({});
    }
    const owner = new mongoose.Types.ObjectId();
    await m.Organization.create({ _id: new mongoose.Types.ObjectId(SYSTEM_ORG_ID), name: 'system', owner, tier: 'unlimited' });
    const acme = await m.Organization.create({ name: 'Acme', owner, tier: 'pro' });
    acmeId = String(acme._id);
    adminId = await member('acme-admin', acmeId, 'admin', ['org_impersonation:write']);
    otherAdminId = await member('acme-admin-2', acmeId, 'admin', ['org_impersonation:write']);
    operatorId = await member('operator', SYSTEM_ORG_ID, 'admin', [], { isSuperAdmin: true });
    targetId = await member('target', acmeId, 'member');
  });

  const policyPath = () => `/organization/${acmeId}/impersonation-policy`;
  const tighten = { allowSelfApproval: false };
  const storedSelfApproval = async () => (await m.Organization.findById(acmeId).lean()).allowSelfApproval;

  /** Earn a password step-up through the real route. */
  async function passwordStepUp(userId: string, accessToken: string): Promise<string> {
    const res = await call('POST', '/auth/step-up', { token: accessToken, body: { password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.body.data.method).toBe('password');
    const claims = JSON.parse(Buffer.from(res.body.data.stepUpToken.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ type: 'step-up', sub: userId, method: 'password' });
    return res.body.data.stepUpToken as string;
  }

  describe('the any-factor gate', () => {
    it('refuses without a step-up token, and nothing is written', async () => {
      const access = await harness.mintAccessToken(adminId, acmeId);
      const res = await call('PATCH', policyPath(), { token: access, body: tighten });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('STEP_UP_REQUIRED');
      expect(await storedSelfApproval()).not.toBe(false);
    });

    it('refuses a wrong password at the issuer — no token is minted', async () => {
      const access = await harness.mintAccessToken(adminId, acmeId);
      const res = await call('POST', '/auth/step-up', { token: access, body: { password: 'not-the-password' } });
      expect(res.status).toBe(401);
      expect(res.body.data?.stepUpToken).toBeUndefined();
    });

    it('admits a fresh token ONCE; the replay of the same jti is refused', async () => {
      const access = await harness.mintAccessToken(adminId, acmeId);
      const stepUp = await passwordStepUp(adminId, access);

      const first = await call('PATCH', policyPath(), { token: access, stepUp, body: tighten });
      expect(first.status).toBe(200);
      expect(await storedSelfApproval()).toBe(false);

      const replay = await call('PATCH', policyPath(), { token: access, stepUp, body: { allowSelfApproval: true } });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('STEP_UP_REPLAY');
      expect(await storedSelfApproval()).toBe(false);
    });

    it('binds the token to its earner: another admin cannot spend it, and the refusal does not burn it', async () => {
      const mine = await harness.mintAccessToken(adminId, acmeId);
      const theirs = await harness.mintAccessToken(otherAdminId, acmeId);
      const stepUp = await passwordStepUp(adminId, mine);

      const stolen = await call('PATCH', policyPath(), { token: theirs, stepUp, body: tighten });
      expect(stolen.status).toBe(401);
      expect(stolen.body.code).toBe('STEP_UP_MISMATCH');
      expect(await storedSelfApproval()).not.toBe(false);

      const own = await call('PATCH', policyPath(), { token: mine, stepUp, body: tighten });
      expect(own.status).toBe(200);
    });

    it('is not satisfied by an access token, an expired step-up, or a token from a foreign key', async () => {
      const access = await harness.mintAccessToken(adminId, acmeId);
      const { signUserJwt } = await import('../src/services/token-signing/index.js');
      const expired = await signUserJwt(
        { type: 'step-up', sub: adminId, method: 'password', amr: ['stepup'], jti: 'expired-jti', iat: Math.floor(Date.now() / 1000) - 120 },
        { expiresIn: -60 },
      );
      // A well-formed step-up signed by a key platform never published.
      const crypto = await import('node:crypto');
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'rogue' })}.${enc({ type: 'step-up', sub: adminId, method: 'totp', jti: 'rogue-jti', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 })}`;
      const forged = `${input}.${crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;

      for (const stepUp of [access, expired, forged]) {
        const res = await call('PATCH', policyPath(), { token: access, stepUp, body: tighten });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('STEP_UP_INVALID');
      }
      expect(await storedSelfApproval()).not.toBe(false);
    });
  });

  describe('the strong-factor gate', () => {
    const impersonate = (access: string, stepUp?: string) => call('POST', `/admin/impersonate/${targetId}`, { token: access, stepUp, body: { reason: 'step-up test' } });

    it('refuses a PASSWORD step-up without consuming it — the same token still works where any factor is accepted', async () => {
      // The operator also administers Acme's policy here, so one token can be tried on both routes.
      await m.UserOrganization.create({ userId: operatorId, organizationId: acmeId, role: 'admin', isActive: true });
      const operatorAccess = await harness.mintAccessToken(operatorId, SYSTEM_ORG_ID);
      const stepUp = await passwordStepUp(operatorId, operatorAccess);

      const strong = await impersonate(operatorAccess, stepUp);
      expect(strong.status).toBe(401);
      expect(strong.body.code).toBe('STEP_UP_METHOD_REQUIRED');
      expect(await m.ImpersonationRequest.countDocuments({})).toBe(0);

      const acmeAccess = await harness.mintAccessToken(operatorId, acmeId);
      const anyFactor = await call('PATCH', policyPath(), { token: acmeAccess, stepUp, body: tighten });
      expect(anyFactor.status).toBe(200);
    });

    it('admits a TOTP step-up earned through /auth/step-up/totp against a real enrolment', async () => {
      const { secret } = await totp.beginEnrolment(operatorId);
      await totp.activate(operatorId, totpUtils.totpCodeForStep(secret, totpUtils.timeStepAt()));
      const operatorAccess = await harness.mintAccessToken(operatorId, SYSTEM_ORG_ID);

      const code = totpUtils.totpCodeForStep(secret, totpUtils.timeStepAt() + 1);
      const earned = await call('POST', '/auth/step-up/totp', { token: operatorAccess, body: { code } });
      expect(earned.status).toBe(200);
      expect(earned.body.data.method).toBe('totp');
      const claims = JSON.parse(Buffer.from(earned.body.data.stepUpToken.split('.')[1], 'base64url').toString());
      expect(claims.amr).toEqual(['stepup', 'mfa']);

      const res = await impersonate(operatorAccess, earned.body.data.stepUpToken);
      expect(res.status).toBe(202);
      expect(await m.ImpersonationRequest.countDocuments({ requesterId: operatorId })).toBe(1);

      // The factor is single-use too: the same code cannot earn a second token.
      const again = await call('POST', '/auth/step-up/totp', { token: operatorAccess, body: { code } });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.body.data?.stepUpToken).toBeUndefined();
    });

    it('a recovery code earns a strong step-up exactly once', async () => {
      const { secret } = await totp.beginEnrolment(operatorId);
      const { recoveryCodes } = await totp.activate(operatorId, totpUtils.totpCodeForStep(secret, totpUtils.timeStepAt()));
      const operatorAccess = await harness.mintAccessToken(operatorId, SYSTEM_ORG_ID);

      const first = await call('POST', '/auth/step-up/totp', { token: operatorAccess, body: { code: recoveryCodes[0] } });
      expect(first.status).toBe(200);
      expect(first.body.data.via).toBe('recovery');
      const second = await call('POST', '/auth/step-up/totp', { token: operatorAccess, body: { code: recoveryCodes[0] } });
      expect(second.status).toBeGreaterThanOrEqual(400);
    });

    it('a weak (aal 1) session is refused before the step-up is even read', async () => {
      const weak = await harness.mintAccessToken(operatorId, SYSTEM_ORG_ID, harness.weakAuth());
      const stepUp = (await tokens.issueStepUpToken(operatorId, 'totp')).token;
      const res = await impersonate(weak, stepUp);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MFA_REQUIRED');

      // ...and the step-up survived that refusal.
      const strong = await harness.mintAccessToken(operatorId, SYSTEM_ORG_ID);
      expect((await impersonate(strong, stepUp)).status).toBe(202);
    });
  });
});
