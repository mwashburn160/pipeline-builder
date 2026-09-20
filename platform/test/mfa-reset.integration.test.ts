// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for MFA recovery without database access, and for the
 * "administrative actions require MFA" claim.
 *
 * What only a real database can tell us:
 *   - the TWO-PERSON rule holds in the atomic claim itself: neither the
 *     requester nor the person being reset can approve, a decided request can't
 *     be approved again, and a lapsed one can't be approved at all;
 *   - one PENDING request per member per org really is a unique index;
 *   - an approved reset removes every factor AND the recovery codes, ends every
 *     session, and grants a PER-USER grace that token issuance honours — even
 *     against a requirement INHERITED from a parent org — while the org's policy
 *     is left exactly as it was;
 *   - `org_admin_aal` is stamped at issuance (own or inherited, strictest wins)
 *     and a policy change bumps every member's session except the actor's.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default), like its siblings.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const RUN = process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';
const suite = RUN ? describe : describe.skip;

suite('MFA reset + admin-actions policy (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, token: any, signing: any, recovery: any, codes: any, claims: any;

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.Organization, m.UserOrganization, m.Role, m.RoleAssignment, m.WebAuthnCredential,
      m.UserTotp, m.MfaRecoveryCodes, m.MfaResetRequest, m.AuditEvent]) {
      await model.createCollection().catch(() => undefined);
    }
    await m.MfaResetRequest.syncIndexes();
    signing = await import('../src/services/token-signing/index.js');
    const { generateSigningKey } = await import('./helpers/signing.js');
    signing._setTokenSigningKeysForTests({ current: generateSigningKey(), retiring: [] });
    token = await import('../src/utils/token.js');
    recovery = await import('../src/services/mfa-recovery.js');
    codes = await import('../src/services/recovery-codes-service.js');
    claims = await import('../src/services/admin-mfa-claims.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let rootId: string;
  let teamId: string;
  let admin1: string;
  let admin2: string;
  let member: string;

  async function makeUser(name: string): Promise<string> {
    const u = await m.User.create({ username: name, email: `${name}@example.com`, password: 'Passw0rdPassw0rd', isEmailVerified: true });
    return String(u._id);
  }

  const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  const load = (id: string) => m.User.findById(id).select('+tokenVersion +isSuperAdmin +refreshSessions');

  beforeEach(async () => {
    for (const model of [m.User, m.Organization, m.UserOrganization, m.WebAuthnCredential, m.UserTotp,
      m.MfaRecoveryCodes, m.MfaResetRequest, m.AuditEvent]) {
      await model.deleteMany({});
    }
    admin1 = await makeUser('admin1');
    admin2 = await makeUser('admin2');
    member = await makeUser('member');
    const root = await m.Organization.create({ name: 'Root', slug: 'root', owner: admin1, tier: 'enterprise' });
    rootId = String(root._id);
    const team = await m.Organization.create({ name: 'Team', slug: 'team', owner: admin1, tier: 'enterprise', parentOrgId: rootId });
    teamId = String(team._id);
    await m.UserOrganization.create({ userId: admin1, organizationId: root._id, role: 'owner' });
    await m.UserOrganization.create({ userId: admin2, organizationId: root._id, role: 'admin' });
    await m.UserOrganization.create({ userId: member, organizationId: team._id, role: 'member' });
    await m.User.updateOne({ _id: member }, { $set: { lastActiveOrgId: teamId } });
    // The member holds a passkey, an authenticator app and a recovery-code set.
    await m.WebAuthnCredential.create({
      userId: member,
      credentialId: `cred-${Date.now()}`,
      publicKey: Buffer.from('x'),
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false,
      name: 'Key',
    });
    await m.UserTotp.create({ userId: member, secret: 'enc', activatedAt: new Date() });
    await codes.issueRecoveryCodesIfAbsent(member);
  });

  const requester = () => ({ id: admin1, email: 'admin1@example.com' });
  const approver = () => ({ id: admin2, email: 'admin2@example.com' });

  describe('the two-person reset', () => {
    it('a second admin approves, and the reset removes every factor and ends every session', async () => {
      await token.issueTokens(await load(member), teamId, { kind: 'interactive', auth: token.signInAuth('webauthn') });
      const before = await load(member);

      const req = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      expect(req.status).toBe('pending');

      const { request, result } = await recovery.approveMfaReset({ requestId: req.id, approver: approver(), graceHours: 48 });
      expect(request).toMatchObject({ status: 'approved', decidedBy: admin2 });
      expect(result).toMatchObject({ passkeysRemoved: 1, totpRemoved: true, recoveryCodesRemoved: true });
      expect(await m.WebAuthnCredential.countDocuments({ userId: member })).toBe(0);
      expect(await m.UserTotp.countDocuments({ userId: member })).toBe(0);
      expect(await m.MfaRecoveryCodes.countDocuments({ userId: member })).toBe(0);

      const after = await load(member);
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
      expect(after.refreshSessions).toHaveLength(0);
      expect(after.mfaResetGraceUntil.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
      expect((await m.MfaResetRequest.findById(req.id).lean()).result.passkeysRemoved).toBe(1);
    });

    it('the requester can never approve their own request', async () => {
      const req = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      await expect(recovery.approveMfaReset({ requestId: req.id, approver: requester() }))
        .rejects.toThrow(recovery.MFA_RESET_SECOND_PERSON_REQUIRED);
      expect(await m.WebAuthnCredential.countDocuments({ userId: member })).toBe(1);
    });

    it('nor can the person being reset', async () => {
      const req = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      await expect(recovery.approveMfaReset({ requestId: req.id, approver: { id: member } }))
        .rejects.toThrow(recovery.MFA_RESET_SECOND_PERSON_REQUIRED);
    });

    it('a request cannot be approved twice', async () => {
      const req = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      await recovery.approveMfaReset({ requestId: req.id, approver: approver() });
      const third = await makeUser('third');
      await expect(recovery.approveMfaReset({ requestId: req.id, approver: { id: third } }))
        .rejects.toThrow(recovery.MFA_RESET_NOT_PENDING);
    });

    it('an expired request cannot be approved, and is marked expired', async () => {
      const req = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      await m.MfaResetRequest.updateOne({ _id: req.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await expect(recovery.approveMfaReset({ requestId: req.id, approver: approver() })).rejects.toThrow(recovery.MFA_RESET_EXPIRED);
      expect((await m.MfaResetRequest.findById(req.id).lean()).status).toBe('expired');
      expect(await m.WebAuthnCredential.countDocuments({ userId: member })).toBe(1);
    });

    it('allows only one PENDING request per member, but a new one after expiry', async () => {
      const first = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      await expect(recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: approver(), reason: 'Lost phone again' }))
        .rejects.toThrow(recovery.MFA_RESET_ALREADY_PENDING);
      await m.MfaResetRequest.updateOne({ _id: first.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await expect(recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: approver(), reason: 'Lost phone again' }))
        .resolves.toMatchObject({ status: 'pending' });
    });

    it('denial closes the request without touching the factors', async () => {
      const req = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      const denied = await recovery.denyMfaReset({ requestId: req.id, actor: approver(), note: 'Could not verify identity' });
      expect(denied).toMatchObject({ status: 'denied', decisionNote: 'Could not verify identity' });
      expect(await m.WebAuthnCredential.countDocuments({ userId: member })).toBe(1);
      await expect(recovery.approveMfaReset({ requestId: req.id, approver: approver() })).rejects.toThrow(recovery.MFA_RESET_NOT_PENDING);
    });

    it('refuses a request for oneself, for a non-member, and for a platform administrator', async () => {
      await expect(recovery.requestMfaReset({ organizationId: rootId, targetUserId: admin1, requester: requester(), reason: 'Lost my own phone' }))
        .rejects.toThrow(recovery.MFA_RESET_SELF);
      await expect(recovery.requestMfaReset({ organizationId: rootId, targetUserId: member, requester: requester(), reason: 'Not a root member' }))
        .rejects.toThrow(recovery.MFA_RESET_NOT_MEMBER);
      await m.User.updateOne({ _id: member }, { $set: { isSuperAdmin: true } });
      await expect(recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' }))
        .rejects.toThrow(recovery.MFA_RESET_PLATFORM_ADMIN);
    });

    it('a sysadmin direct reset works alone and supersedes a pending request', async () => {
      const req = await recovery.requestMfaReset({ organizationId: teamId, targetUserId: member, requester: requester(), reason: 'Lost phone and laptop' });
      const sysadmin = await makeUser('sysadmin');
      const result = await recovery.directMfaReset({ targetUserId: member, actor: { id: sysadmin, isSuperAdmin: true } });
      expect(result).toMatchObject({ passkeysRemoved: 1, totpRemoved: true, recoveryCodesRemoved: true });
      expect((await m.MfaResetRequest.findById(req.id).lean()).status).toBe('denied');
    });
  });

  describe('the per-user enrolment grace', () => {
    it('lets the reset person sign in despite a requirement INHERITED from the parent, without changing it', async () => {
      await m.Organization.updateOne({ _id: rootId }, { $set: { requireMfa: true, mfaRequiredSince: new Date() } });
      // Before the reset, a password session for the team is refused.
      await expect(token.issueTokens(await load(member), teamId, { kind: 'interactive', auth: token.signInAuth('pwd') }))
        .rejects.toThrow('MFA_REQUIRED_FOR_ORG');

      await recovery.resetFactors(member, 24);
      await expect(token.issueTokens(await load(member), teamId, { kind: 'interactive', auth: token.signInAuth('pwd') }))
        .resolves.toBeTruthy();
      expect((await m.Organization.findById(rootId).lean()).requireMfa).toBe(true);

      // Only THIS person is exempt.
      await m.UserOrganization.create({ userId: admin2, organizationId: teamId, role: 'member' });
      await expect(token.issueTokens(await load(admin2), teamId, { kind: 'interactive', auth: token.signInAuth('pwd') }))
        .rejects.toThrow('MFA_REQUIRED_FOR_ORG');
    });

    it('ends when the grace passes', async () => {
      await m.Organization.updateOne({ _id: teamId }, { $set: { requireMfa: true } });
      await recovery.resetFactors(member, 24);
      await m.User.updateOne({ _id: member }, { $set: { mfaResetGraceUntil: new Date(Date.now() - 1000) } });
      await expect(token.issueTokens(await load(member), teamId, { kind: 'interactive', auth: token.signInAuth('pwd') }))
        .rejects.toThrow('MFA_REQUIRED_FOR_ORG');
    });
  });

  describe('the admin-actions policy claim', () => {
    it('is absent by default and stamped when the org (or a parent) turns it on', async () => {
      let t = await token.issueTokens(await load(member), teamId, { kind: 'interactive', auth: token.signInAuth('pwd') });
      expect(decode(t.accessToken).org_admin_aal).toBeUndefined();

      await m.Organization.updateOne({ _id: rootId }, { $set: { adminActionsRequireMfa: true } });
      t = await token.issueTokens(await load(member), teamId, { kind: 'interactive', auth: token.signInAuth('pwd') });
      expect(decode(t.accessToken).org_admin_aal).toBe(2);
    });

    it('a policy change bumps every member of the org and its teams — except the actor', async () => {
      const before = {
        admin1: (await load(admin1)).tokenVersion,
        admin2: (await load(admin2)).tokenVersion,
        member: (await load(member)).tokenVersion,
      };
      const bumped = await claims.refreshAdminPolicyClaims(rootId, admin1);
      expect(bumped).toBe(2);
      expect((await load(admin1)).tokenVersion).toBe(before.admin1);
      expect((await load(admin2)).tokenVersion).toBe(before.admin2 + 1);
      expect((await load(member)).tokenVersion).toBe(before.member + 1);
    });
  });
});
