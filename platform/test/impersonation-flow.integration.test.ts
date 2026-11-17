// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Impersonation, end to end through the REAL route table and a real Mongo:
 *
 *   request (consent policy) → challenge delivered → subject approves →
 *   requester redeems (step-up gated, single-use) → the token works as the
 *   target → read-only (writes refused, including through a header the pre-auth
 *   peek cannot parse) → the session ends when it is revoked, when the
 *   OPERATOR is revoked (tokenVersion bump / superadmin flag lost), and — for a
 *   session opened under TENANT authority (parent-org admin) — when the
 *   operator's claimsVersion moves.
 *
 * The mocked suites (impersonate.test.ts, impersonation-request.test.ts,
 * auth-impersonation-session.test.ts) pin each step against a stand-in; what
 * only this can prove is that the steps COMPOSE: the record the controller
 * writes is the one `requireAuth` reads, the stamp `redeem` takes is the one the
 * operator rule compares, and the policy/authority the request saw is the one
 * the token carries.
 *
 * Boundaries stubbed: the message service (the challenge is in-app only — a
 * local HTTP stub answers 201 and records it) and the quota service. Step-up
 * tokens are minted with the real issuer (`issueStepUpToken`, method `totp`);
 * EARNING one through `/auth/step-up/*` is step-up-flow.integration.test.ts.
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
const suite = integrationSuite();

suite('impersonation flow (real routes, real Mongo)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, harness: any, tokens: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let stub: { close: () => Promise<void>; port: number; calls: { method: string; path: string; body: unknown }[] };
  let app: { base: string; close: () => Promise<void> };
  let call: (method: string, path: string, opts?: Record<string, unknown>) => Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();

    // Downstream services BEFORE config is imported.
    const { startStubServices } = await import('./helpers/stub-services.js');
    stub = await startStubServices();
    process.env.MESSAGE_SERVICE_HOST = '127.0.0.1';
    process.env.MESSAGE_SERVICE_PORT = String(stub.port);
    process.env.MESSAGE_ENABLED = 'true';
    process.env.QUOTA_SERVICE_HOST = '127.0.0.1';
    process.env.QUOTA_SERVICE_PORT = String(stub.port);

    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.UserOrganization, m.Organization, m.Role, m.RoleAssignment, m.ImpersonationRequest]) {
      await model.createCollection().catch(() => undefined);
    }
    harness = await import('./helpers/platform-app.js');
    tokens = await import('../src/services/session/access-tokens.js');
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

  let operatorId: string;
  let targetId: string;
  let tenantAdminId: string;
  let acmeId: string;

  async function member(username: string, orgId: string, role: 'owner' | 'admin' | 'member', permissions: string[] = [], extra: Record<string, unknown> = {}) {
    const user = await m.User.create({
      username, email: `${username}@example.com`, password: 'Passw0rd!Passw0rd', isEmailVerified: true, lastActiveOrgId: orgId, ...extra,
    });
    await m.UserOrganization.create({ userId: user._id, organizationId: orgId, role, isActive: true });
    if (permissions.length > 0) {
      const r = await m.Role.create({ organizationId: orgId, name: `${username}-role`, permissions });
      await m.RoleAssignment.create({ userId: user._id, roleId: r._id, organizationId: orgId });
    }
    return String(user._id);
  }

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.Role, m.RoleAssignment, m.ImpersonationRequest]) {
      await model.deleteMany({});
    }
    stub.calls.length = 0;
    const owner = new mongoose.Types.ObjectId();
    await m.Organization.create({ _id: new mongoose.Types.ObjectId(SYSTEM_ORG_ID), name: 'system', owner, tier: 'unlimited' });
    const acme = await m.Organization.create({ name: 'Acme', owner, tier: 'pro' });
    acmeId = String(acme._id);
    operatorId = await member('operator', SYSTEM_ORG_ID, 'admin', [], { isSuperAdmin: true });
    targetId = await member('target', acmeId, 'member');
    tenantAdminId = await member('acme-admin', acmeId, 'admin', ['impersonation:approve']);
  });

  const stepUp = async (userId: string, method = 'totp') => (await tokens.issueStepUpToken(userId, method)).token as string;
  const operatorToken = () => harness.mintAccessToken(operatorId, SYSTEM_ORG_ID);

  /** Request → (challenge) → subject approves → requester redeems. Returns the session token + request id. */
  async function openConsentedSession(): Promise<{ accessToken: string; requestId: string }> {
    const op = await operatorToken();
    const requested = await call('POST', `/admin/impersonate/${targetId}`, {
      token: op, stepUp: await stepUp(operatorId), body: { reason: 'Ticket 4521: dashboard empty' },
    });
    expect(requested.status).toBe(202);
    const requestId = requested.body.data.requestId as string;

    const decided = await call('POST', `/admin/impersonate/requests/${requestId}/decide`, {
      token: await harness.mintAccessToken(targetId, acmeId, harness.weakAuth()), body: { approve: true },
    });
    expect(decided.status).toBe(200);

    const redeemed = await call('POST', `/admin/impersonate/requests/${requestId}/redeem`, {
      token: op, stepUp: await stepUp(operatorId),
    });
    expect(redeemed.status).toBe(200);
    return { accessToken: redeemed.body.data.accessToken as string, requestId };
  }

  describe('consent → approve → redeem', () => {
    it('opens a pending request, routes the challenge to the subject, and issues nothing yet', async () => {
      const res = await call('POST', `/admin/impersonate/${targetId}`, {
        token: await operatorToken(), stepUp: await stepUp(operatorId), body: { reason: 'Ticket 4521' },
      });

      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ status: 'pending', approverMode: 'user' });
      expect(res.body.data.accessToken).toBeUndefined();

      const row = await m.ImpersonationRequest.findById(res.body.data.requestId).lean();
      expect(row.status).toBe('pending');
      expect(String(row.approverUserId)).toBe(targetId);
      expect(String(row.organizationId)).toBe(acmeId);
      expect(row.jti ?? null).toBeNull();

      // The challenge actually went out, to the subject, in the pinned org.
      const notices = stub.calls.filter((c) => c.method === 'POST' && JSON.stringify(c.body ?? '').includes(targetId));
      expect(notices).toHaveLength(1);
      expect(notices[0].body).toMatchObject({ recipientOrgId: acmeId, recipientUserId: targetId });
    });

    it('refuses to redeem before approval, and refuses the requester deciding their own request', async () => {
      const op = await operatorToken();
      const requested = await call('POST', `/admin/impersonate/${targetId}`, { token: op, stepUp: await stepUp(operatorId) });
      const id = requested.body.data.requestId;

      const early = await call('POST', `/admin/impersonate/requests/${id}/redeem`, { token: op, stepUp: await stepUp(operatorId) });
      expect(early.status).toBe(409);

      const self = await call('POST', `/admin/impersonate/requests/${id}/decide`, { token: op, body: { approve: true } });
      expect(self.status).toBe(403);
      expect((await m.ImpersonationRequest.findById(id).lean()).status).toBe('pending');
    });

    it('lets an org admin holding impersonation:approve decide an org_admin-routed request, but not a bystander member', async () => {
      const bystander = await member('bystander', acmeId, 'member');
      const requested = await call('POST', `/admin/impersonate/${targetId}`, {
        token: await operatorToken(), stepUp: await stepUp(operatorId), body: { approverMode: 'org_admin' },
      });
      expect(requested.status).toBe(202);
      const id = requested.body.data.requestId;

      const refused = await call('POST', `/admin/impersonate/requests/${id}/decide`, {
        token: await harness.mintAccessToken(bystander, acmeId, harness.weakAuth()), body: { approve: true },
      });
      expect(refused.status).toBe(403);

      const ok = await call('POST', `/admin/impersonate/requests/${id}/decide`, {
        token: await harness.mintAccessToken(tenantAdminId, acmeId, harness.weakAuth()), body: { approve: true },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('approved');
    });

    it('requires a strong step-up to redeem, and the approval is single-use', async () => {
      const op = await operatorToken();
      const requested = await call('POST', `/admin/impersonate/${targetId}`, { token: op, stepUp: await stepUp(operatorId) });
      const id = requested.body.data.requestId;
      await call('POST', `/admin/impersonate/requests/${id}/decide`, {
        token: await harness.mintAccessToken(targetId, acmeId, harness.weakAuth()), body: { approve: true },
      });

      const noStepUp = await call('POST', `/admin/impersonate/requests/${id}/redeem`, { token: op });
      expect(noStepUp.status).toBe(401);
      expect(noStepUp.body.code).toBe('STEP_UP_REQUIRED');

      const passwordStepUp = await call('POST', `/admin/impersonate/requests/${id}/redeem`, { token: op, stepUp: await stepUp(operatorId, 'password') });
      expect(passwordStepUp.status).toBe(401);
      expect(passwordStepUp.body.code).toBe('STEP_UP_METHOD_REQUIRED');

      const first = await call('POST', `/admin/impersonate/requests/${id}/redeem`, { token: op, stepUp: await stepUp(operatorId) });
      expect(first.status).toBe(200);
      const second = await call('POST', `/admin/impersonate/requests/${id}/redeem`, { token: op, stepUp: await stepUp(operatorId) });
      expect(second.status).toBe(409);

      const row = await m.ImpersonationRequest.findById(id).select('+jti').lean();
      expect(row.status).toBe('consumed');
      expect(row.requesterSuperAdmin).toBe(true);
      expect(typeof row.requesterTokenVersion).toBe('number');
    });

    it('refuses a weak (aal 1) operator session outright', async () => {
      const weak = await harness.mintAccessToken(operatorId, SYSTEM_ORG_ID, harness.weakAuth());
      const res = await call('POST', `/admin/impersonate/${targetId}`, { token: weak, stepUp: await stepUp(operatorId) });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MFA_REQUIRED');
      expect(await m.ImpersonationRequest.countDocuments({})).toBe(0);
    });
  });

  describe('the session token', () => {
    it('reads as the TARGET, pinned to the approved org, naming the operator', async () => {
      const { accessToken } = await openConsentedSession();
      const res = await call('GET', '/user/profile', { token: accessToken });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('target@example.com');

      const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
      expect(claims).toMatchObject({ sub: targetId, impersonatorId: operatorId, impersonationReadOnly: true, organizationId: acmeId });
      // Inherits — never raises — the OPERATOR's assurance.
      expect(claims.aal).toBe(2);
    });

    it('refuses writes (403 IMPERSONATION_READ_ONLY) and the write never lands', async () => {
      const { accessToken } = await openConsentedSession();
      const res = await call('PATCH', '/user/profile', { token: accessToken, body: { username: 'pwned' } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
      expect((await m.User.findById(targetId).lean()).username).toBe('target');
    });

    it('a malformed `Bearer <jwt> .x` header cannot slip a write past the fence', async () => {
      const { accessToken } = await openConsentedSession();
      // The pre-auth peek cannot parse this (4 dot-segments) so it lets it by;
      // requireAuth must then read the SAME whole credential, not `split(' ')[1]`.
      const dotted = await call('PATCH', '/user/profile', { authorization: `Bearer ${accessToken} .x`, body: { username: 'pwned' } });
      expect(dotted.status).toBe(401);
      // Neighbouring malformations: refused either by the fence (the peek still
      // parses the payload segment) or by requireAuth (the credential does not
      // verify) — never admitted.
      for (const authorization of [`Bearer ${accessToken} x`, `Bearer  ${accessToken}`, `Bearer ${accessToken}.x`, `bearer ${accessToken}`]) {
        const res = await call('PATCH', '/user/profile', { authorization, body: { username: 'pwned' } });
        expect([401, 403]).toContain(res.status);
      }
      expect((await m.User.findById(targetId).lean()).username).toBe('target');
    });

    it('requireAuth refuses the write on its own, with the pre-auth fence removed', async () => {
      const { accessToken } = await openConsentedSession();
      const bare = await harness.startPlatformApp({ preAuthFence: false });
      try {
        const res = await harness.client(bare.base)('PATCH', '/user/profile', { token: accessToken, body: { username: 'pwned' } });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
      } finally {
        await bare.close();
      }
      expect((await m.User.findById(targetId).lean()).username).toBe('target');
    });

    it('cannot open a nested impersonation from inside a session', async () => {
      const { accessToken } = await openConsentedSession();
      // POST is refused by the read-only fence before the controller's own check.
      const res = await call('POST', `/admin/impersonate/${tenantAdminId}`, { token: accessToken, stepUp: await stepUp(targetId) });
      expect(res.status).toBe(403);
    });
  });

  describe('revocation ends the session on its next request', () => {
    const ended = (res: { status: number; body: { message?: string } }) => {
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Impersonation session ended');
    };

    it('the subject withdrawing consent', async () => {
      const { accessToken, requestId } = await openConsentedSession();
      expect((await call('GET', '/user/profile', { token: accessToken })).status).toBe(200);

      const revoked = await call('POST', `/admin/impersonate/requests/${requestId}/revoke`, {
        token: await harness.mintAccessToken(targetId, acmeId, harness.weakAuth()),
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.data.status).toBe('revoked');
      // No Redis in the suite: the platform refuses it, and says it could not publish further.
      expect(revoked.body.data.revokedEverywhere).toBe(false);

      ended(await call('GET', '/user/profile', { token: accessToken }));
    });

    it('the operator signing out everywhere (tokenVersion bump)', async () => {
      const { accessToken } = await openConsentedSession();
      await m.User.updateOne({ _id: operatorId }, { $inc: { tokenVersion: 1 } });
      ended(await call('GET', '/user/profile', { token: accessToken }));
    });

    it('a superadmin-opened session when the operator loses the flag', async () => {
      const { accessToken } = await openConsentedSession();
      await m.User.updateOne({ _id: operatorId }, { $set: { isSuperAdmin: false } });
      ended(await call('GET', '/user/profile', { token: accessToken }));
    });

    it('a superadmin-opened session deliberately IGNORES a claimsVersion move', async () => {
      const { accessToken } = await openConsentedSession();
      await m.User.updateOne({ _id: operatorId }, { $inc: { claimsVersion: 1 } });
      expect((await call('GET', '/user/profile', { token: accessToken })).status).toBe(200);
    });

    it('the operator account being deleted', async () => {
      const { accessToken } = await openConsentedSession();
      await m.User.deleteOne({ _id: operatorId });
      ended(await call('GET', '/user/profile', { token: accessToken }));
    });
  });

  describe('tenant authority (parent-org admin → team member)', () => {
    let parentAdminId: string;
    let teamMemberId: string;
    let parentId: string;
    let teamId: string;

    beforeEach(async () => {
      const owner = new mongoose.Types.ObjectId();
      const parent = await m.Organization.create({ name: 'Parent', owner, tier: 'pro' });
      const team = await m.Organization.create({ name: 'Team', owner, tier: 'pro', parentOrgId: String(parent._id) });
      parentId = String(parent._id); teamId = String(team._id);
      parentAdminId = await member('parent-admin', parentId, 'admin', ['team_access:open', 'impersonation:approve']);
      teamMemberId = await member('team-member', teamId, 'member');
    });

    const openAsParent = async () => call('POST', `/admin/impersonate/${teamMemberId}`, {
      token: await harness.mintAccessToken(parentAdminId, parentId), stepUp: await stepUp(parentAdminId), body: { orgId: teamId },
    });

    it('opens inline (informed, not asked) and stamps the operator claimsVersion', async () => {
      const res = await openAsParent();
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('consumed');
      const row = await m.ImpersonationRequest.findById(res.body.data.requestId).lean();
      expect(row.requesterSuperAdmin).toBe(false);
      expect(row.requesterClaimsVersion).toBe(0);
      expect((await call('GET', '/user/profile', { token: res.body.data.accessToken })).status).toBe(200);
    });

    it('ends when the operator claimsVersion moves (role / membership change)', async () => {
      const res = await openAsParent();
      const session = res.body.data.accessToken;
      await m.User.updateOne({ _id: parentAdminId }, { $inc: { claimsVersion: 1 } });
      const after = await call('GET', '/user/profile', { token: session });
      expect(after.status).toBe(401);
      expect(after.body.message).toBe('Impersonation session ended');
    });

    it('is refused without team_access:open, and never reaches a sibling or the parent', async () => {
      await m.RoleAssignment.deleteMany({ userId: parentAdminId });
      const res = await openAsParent();
      expect(res.status).toBe(403);
      expect(await m.ImpersonationRequest.countDocuments({})).toBe(0);
    });
  });
});
