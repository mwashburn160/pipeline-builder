// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the database-backed halves of #8: the org "require MFA"
 * refusal at ISSUANCE, the bootstrap-administrator exception's full lifecycle,
 * and the operator recovery command.
 *
 * What only a real database can tell us:
 *   - `mintTokens` really does refuse an `aal: 1` session for an enforcing org,
 *     on every path that mints one (sign-in, renewal, switch-org) — the point of
 *     enforcing at issuance is that there is exactly ONE chokepoint, and a
 *     stand-in for Mongo would only prove the stand-in was wired up;
 *   - `renewSessionTokens` reads `aal` off the stored SLOT, so a refresh cannot
 *     raise it even when the caller asks for something else;
 *   - the exception's open/closed state is a function of three real collections
 *     (`users`, `userorganizations`, `webauthncredentials`/`usertotps`), and
 *     "never reopens after the factor is removed" is precisely a statement about
 *     what is persisted;
 *   - `recoverMfa` — the ONE recovery path, and the one that must not be
 *     discovered to be broken on the day it is needed — removes every factor,
 *     bumps `tokenVersion` and clears the slots in a single pass.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default), mirroring
 * totp.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.BOOTSTRAP_SUPERADMIN_EMAILS = 'boot@internal';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const RUN = process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';
const suite = RUN ? describe : describe.skip;

/** The system org's well-known id — the exception is scoped to its members. */
const SYSTEM_ORG_ID = '000000000000000000000001';

suite('Required MFA and the bootstrap exception (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, token: any, bootstrap: any, mfaPolicy: any, signing: any, recover: any;

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.Organization, m.UserOrganization, m.Role, m.RoleAssignment, m.WebAuthnCredential, m.UserTotp, m.AuditEvent]) {
      await model.createCollection().catch(() => undefined);
    }
    // Platform normally loads its signing key at boot; give it an in-memory one.
    signing = await import('../src/services/token-signing/index.js');
    const { generateSigningKey } = await import('./helpers/signing.js');
    signing._setTokenSigningKeysForTests({ current: generateSigningKey(), retiring: [] });

    token = await import('../src/utils/token.js');
    bootstrap = await import('../src/helpers/bootstrap-admin.js');
    mfaPolicy = await import('../src/helpers/mfa-policy.js');
    // The SERVICE, not the script: the script's entry point ends in
    // `process.exit`, so importing it would take the test runner with it.
    recover = await import('../src/services/mfa-recovery.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let userId: string;
  let user: any;
  let orgId: string;

  beforeEach(async () => {
    for (const model of [m.User, m.Organization, m.UserOrganization, m.WebAuthnCredential, m.UserTotp, m.AuditEvent]) {
      await model.deleteMany({});
    }
    const org = await m.Organization.create({ _id: SYSTEM_ORG_ID, name: 'system', slug: 'system', isSystem: true, owner: new mongoose.Types.ObjectId(), tier: 'enterprise' });
    orgId = String(org._id);
    const created = await m.User.create({ username: 'boot', email: 'boot@internal', password: 'Passw0rdPassw0rd', isEmailVerified: true });
    userId = String(created._id);
    await m.UserOrganization.create({ userId, organizationId: org._id, role: 'owner' });
    await m.User.updateOne({ _id: userId }, { $set: { lastActiveOrgId: orgId } });
    user = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin');
  });

  /** Register a passkey row — the cheapest way to say "this account has a factor". */
  async function addPasskey(): Promise<void> {
    await m.WebAuthnCredential.create({
      userId,
      credentialId: `cred-${Date.now()}`,
      publicKey: Buffer.from('x'),
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false,
      name: 'Test key',
    });
  }

  /** Turn the org's requirement on, with or without a grace period. */
  async function requireMfa(opts: { graceUntil?: Date } = {}): Promise<void> {
    await m.Organization.updateOne({ _id: orgId }, {
      $set: { requireMfa: true, mfaRequiredSince: new Date(), ...(opts.graceUntil ? { mfaGraceUntil: opts.graceUntil } : {}) },
      ...(opts.graceUntil ? {} : { $unset: { mfaGraceUntil: '' } }),
    });
  }

  describe('org policy at issuance', () => {
    it('issues normally when the org requires nothing', async () => {
      const tokens = await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') });
      expect(tokens.accessToken).toBeTruthy();
    });

    it('refuses an aal-1 session once the requirement is ENFORCED', async () => {
      await requireMfa();
      await expect(token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') }))
        .rejects.toThrow('MFA_REQUIRED_FOR_ORG');
    });

    it('admits an aal-2 session under the same policy', async () => {
      await requireMfa();
      const tokens = await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('webauthn') });
      expect(tokens.accessToken).toBeTruthy();
    });

    it('admits an aal-1 session while the grace period is still running', async () => {
      // The grace period is what stops enabling the policy from signing out
      // everyone who has not enrolled yet.
      await requireMfa({ graceUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
      const tokens = await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') });
      expect(tokens.accessToken).toBeTruthy();
      expect((await mfaPolicy.resolveEffectiveMfaPolicy(orgId)).enforced).toBe(false);
    });

    it('refuses once that grace period has passed', async () => {
      await requireMfa({ graceUntil: new Date(Date.now() - 1000) });
      await expect(token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') }))
        .rejects.toThrow('MFA_REQUIRED_FOR_ORG');
    });

    it('exempts a SCOPED machine credential — automation must not die when a policy lands', async () => {
      await requireMfa();
      const tokens = await token.issueTokens(user, orgId, {
        kind: 'machine', auth: token.signInAuth('pwd'), scope: 'reporting:ingest',
      });
      expect(tokens.accessToken).toBeTruthy();
    });

    it('refuses a REFRESH of a session opened before the policy landed', async () => {
      // This IS the enforcement for existing sessions: they stop being re-issued.
      const tokens = await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') });
      const fresh = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin +refreshSessions');
      const slot = fresh.refreshSessions[0];
      await requireMfa();
      await expect(token.renewSessionTokens(fresh, orgId, { sessionId: slot.id, presentedToken: tokens.refreshToken, kind: 'interactive' }))
        .rejects.toThrow('MFA_REQUIRED_FOR_ORG');
    });

    it('stamps the mfaRequired claim so no service has to look the policy up', async () => {
      await requireMfa({ graceUntil: new Date(Date.now() + 86_400_000) });
      const tokens = await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') });
      const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString());
      expect(claims.mfaRequired).toBe(true);
      expect(claims.aal).toBe(1);
    });
  });

  describe('a refresh never raises assurance', () => {
    it('re-issues at the slot\'s stored aal, not at whatever the caller is', async () => {
      const issued = await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') });
      const fresh = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin +refreshSessions');
      const slot = fresh.refreshSessions[0];
      expect(slot.aal).toBe(1);

      const renewed = await token.renewSessionTokens(fresh, orgId, { sessionId: slot.id, presentedToken: issued.refreshToken, kind: 'interactive' });
      const claims = JSON.parse(Buffer.from(renewed.accessToken.split('.')[1], 'base64url').toString());
      expect(claims.aal).toBe(1);
      // …and auth_time is not reset either.
      expect(claims.auth_time).toBe(Math.floor(new Date(slot.authTime).getTime() / 1000));
    });

    it('carries an aal-2 slot through a renewal unchanged', async () => {
      const issued = await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('webauthn') });
      const fresh = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin +refreshSessions');
      const slot = fresh.refreshSessions[0];
      const renewed = await token.renewSessionTokens(fresh, orgId, { sessionId: slot.id, presentedToken: issued.refreshToken, kind: 'interactive' });
      const claims = JSON.parse(Buffer.from(renewed.accessToken.split('.')[1], 'base64url').toString());
      expect(claims.aal).toBe(2);
    });
  });

  describe('the bootstrap exception, end to end', () => {
    it('is OPEN for the bootstrap admin with no factor', async () => {
      expect(await bootstrap.isBootstrapExceptionOpen(await m.User.findById(userId).lean())).toBe(true);
    });

    it('is CLOSED for an address that is not on the operator list', async () => {
      const other = await m.User.create({ username: 'someone', email: 'someone@acme.com', password: 'Passw0rdPassw0rd' });
      await m.UserOrganization.create({ userId: String(other._id), organizationId: SYSTEM_ORG_ID, role: 'member' });
      expect(await bootstrap.isBootstrapExceptionOpen(await m.User.findById(other._id).lean())).toBe(false);
    });

    it('is CLOSED for a bootstrap address that is not in the system org', async () => {
      await m.UserOrganization.deleteMany({ userId });
      expect(await bootstrap.isBootstrapExceptionOpen(await m.User.findById(userId).lean())).toBe(false);
    });

    it('is CLOSED as soon as a factor exists, even before the flag is written', async () => {
      await addPasskey();
      expect(await bootstrap.isBootstrapExceptionOpen(await m.User.findById(userId).lean())).toBe(false);
    });

    it('issues a LIMITED session while open, and the flag lives on the slot', async () => {
      const tokens = await token.issueTokens(user, orgId, {
        kind: 'interactive', auth: token.signInAuth('pwd'), mfaEnrollmentPending: true,
      });
      const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString());
      expect(claims.mfaEnrollmentPending).toBe(true);
      expect(claims.aal).toBe(1);

      const fresh = await m.User.findById(userId).select('+refreshSessions');
      expect(fresh.refreshSessions[0].mfaEnrollmentPending).toBe(true);
    });

    it('keeps the limit across a refresh — it is part of what the session IS', async () => {
      const issued = await token.issueTokens(user, orgId, {
        kind: 'interactive', auth: token.signInAuth('pwd'), mfaEnrollmentPending: true,
      });
      const fresh = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin +refreshSessions');
      const slot = fresh.refreshSessions[0];
      const renewed = await token.renewSessionTokens(fresh, orgId, { sessionId: slot.id, presentedToken: issued.refreshToken, kind: 'interactive' });
      const claims = JSON.parse(Buffer.from(renewed.accessToken.split('.')[1], 'base64url').toString());
      expect(claims.mfaEnrollmentPending).toBe(true);
    });

    it('is EXEMPT from the org policy — it exists so the person can go and satisfy it', async () => {
      await requireMfa();
      const tokens = await token.issueTokens(user, orgId, {
        kind: 'interactive', auth: token.signInAuth('pwd'), mfaEnrollmentPending: true,
      });
      expect(tokens.accessToken).toBeTruthy();
    });

    it('CLOSES on the first enrolment, stamps the moment, and un-limits the slots', async () => {
      await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('pwd'), mfaEnrollmentPending: true });
      await addPasskey();
      await bootstrap.closeBootstrapExceptionOnEnrolment({ user: { sub: userId } } as never, userId);

      const after = await m.User.findById(userId).select('+refreshSessions').lean();
      expect(after.mfaBootstrapClosedAt).toBeInstanceOf(Date);
      expect(after.refreshSessions[0].mfaEnrollmentPending).toBeUndefined();
    });

    it('closes only ONCE — a later enrolment must not move the timestamp', async () => {
      expect(await bootstrap.closeBootstrapException(userId)).toBe(true);
      const first = (await m.User.findById(userId).lean()).mfaBootstrapClosedAt;
      expect(await bootstrap.closeBootstrapException(userId)).toBe(false);
      expect((await m.User.findById(userId).lean()).mfaBootstrapClosedAt).toEqual(first);
    });

    it('NEVER REOPENS once closed, even after every factor is removed', async () => {
      await addPasskey();
      await bootstrap.closeBootstrapException(userId);
      await m.WebAuthnCredential.deleteMany({ userId });
      // No factor, still on the operator list, still in the system org — and
      // still closed, because the account demonstrably had a way to enrol one.
      expect(await bootstrap.isBootstrapExceptionOpen(await m.User.findById(userId).lean())).toBe(false);
    });

    it('sees an ACTIVATED authenticator app as a factor, but not a half-finished enrolment', async () => {
      await m.UserTotp.create({ userId, secret: 'enc', recoveryCodes: [] });
      expect(await bootstrap.hasAnyMfaFactor(userId)).toBe(false);
      await m.UserTotp.updateOne({ userId }, { $set: { activatedAt: new Date() } });
      expect(await bootstrap.hasAnyMfaFactor(userId)).toBe(true);
    });
  });

  describe('the operator recovery command', () => {
    it('removes every factor, ends every session and records who did it', async () => {
      await addPasskey();
      await m.UserTotp.create({ userId, secret: 'enc', recoveryCodes: [], activatedAt: new Date() });
      await token.issueTokens(user, orgId, { kind: 'interactive', auth: token.signInAuth('webauthn') });
      const before = await m.User.findById(userId).select('+tokenVersion').lean();

      const result = await recover.recoverMfa({ email: 'boot@internal', operator: 'ops@example.com' });

      expect(result).toMatchObject({ userId, passkeysRemoved: 1, totpRemoved: true });
      expect(await m.WebAuthnCredential.countDocuments({ userId })).toBe(0);
      expect(await m.UserTotp.countDocuments({ userId })).toBe(0);

      const after = await m.User.findById(userId).select('+tokenVersion +refreshSessions').lean();
      // tokenVersion bump + cleared slots = "sign out everywhere", so a reset
      // can never leave a live session that predates it.
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
      expect(after.refreshSessions).toHaveLength(0);

      const audit = await m.AuditEvent.findOne({ action: 'auth.mfa.operator_reset' }).lean();
      expect(audit).not.toBeNull();
      expect(audit.actorId).toBe('ops@example.com');
      expect(audit.targetId).toBe(userId);
    });

    it('does NOT reopen the bootstrap exception', async () => {
      await addPasskey();
      await bootstrap.closeBootstrapException(userId);
      await recover.recoverMfa({ email: 'boot@internal', operator: 'ops@example.com' });
      expect(await bootstrap.isBootstrapExceptionOpen(await m.User.findById(userId).lean())).toBe(false);
    });

    it('can clear the org policy in the same pass, so the person can sign back in and re-enrol', async () => {
      await requireMfa();
      await addPasskey();
      const result = await recover.recoverMfa({ email: 'boot@internal', operator: 'ops@example.com', clearOrgPolicy: true });
      expect(result.orgPolicyCleared).toBe(orgId);
      expect((await mfaPolicy.resolveEffectiveMfaPolicy(orgId)).requireMfa).toBe(false);
      // …and the now factor-less admin can open a session again.
      const fresh = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin');
      await expect(token.issueTokens(fresh, orgId, { kind: 'interactive', auth: token.signInAuth('pwd') })).resolves.toBeTruthy();
    });

    it('returns null for an address that has no account', async () => {
      expect(await recover.recoverMfa({ email: 'nobody@example.com', operator: 'ops@example.com' })).toBeNull();
    });
  });
});
