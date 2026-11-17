// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo, REAL-crypto passkey ceremonies: registration → sign-in → step-up,
 * driven through `services/webauthn-service.ts` with a software authenticator
 * (`helpers/soft-authenticator.ts`) instead of a mocked `@simplewebauthn/server`.
 *
 * What the mocked suites cannot prove, and this does:
 *   - the bytes a real authenticator produces actually verify against the
 *     configured RP (rpIdHash, origin, challenge, UV flag, COSE key, signature);
 *   - each of those, wrong, is REFUSED by the library as we call it — not by a
 *     mock that was told to refuse;
 *   - the stored credential (public key, counter, AAGUID) round-trips through
 *     Mongo and the next assertion verifies against what was stored;
 *   - the counter advances in the database, and a stale counter (a cloned
 *     authenticator) is refused without moving it;
 *   - ceremonies are single-use and bound to the user / kind that started them;
 *   - the org authenticator allowlist refuses an unattested registration, and
 *     demotes a non-allowlisted passkey to `aal: 1` at sign-in (the real rule:
 *     "doesn't count", not "refused").
 *
 * Gated behind RUN_MONGO_INTEGRATION=1. A replica set because passkey removal
 * runs in a transaction (`removeUnlessLastSignInMethod`).
 */

import { it, expect, beforeAll, afterAll, beforeEach, describe } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';
import { SoftAuthenticator } from './helpers/soft-authenticator.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
const RP_ID = 'app.example.test';
const ORIGIN = 'https://app.example.test';
process.env.WEBAUTHN_RP_ID = RP_ID;
process.env.WEBAUTHN_ORIGINS = ORIGIN;
// Never reach the public FIDO Metadata Service: metadata is installed per test.
process.env.FIDO_MDS_URL = 'off';
delete process.env.FIDO_MDS_BLOB_PATH;
// Ceremony state falls back to the in-process store without Redis.
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

const YUBIKEY = 'cb69481e-8ff7-4039-93ec-0a2729a154a8';
const OTHER_MODEL = 'ee882879-721c-4913-9775-3dfcce97072a';

suite('WebAuthn ceremonies (real Mongo, software authenticator)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, svc: any, errors: any, policy: any, mds: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.WebAuthnCredential, m.Organization, m.UserOrganization, m.UserTotp, m.MfaRecoveryCodes, m.OAuthAccount].filter(Boolean)) {
      await model.createCollection().catch(() => undefined);
    }
    await m.WebAuthnCredential.syncIndexes();
    svc = await import('../src/services/webauthn-service.js');
    errors = await import('../src/services/webauthn-errors.js');
    policy = await import('../src/helpers/authenticator-policy.js');
    mds = await import('../src/services/fido-mds.js');
    // The policy demotion counts itself; give the metrics helpers a registry.
    const { Registry } = await import('prom-client');
    (await import('../src/observability/metrics.js')).setMetricsRegistry(new Registry());
  }, 180_000);

  afterAll(async () => {
    if (mds) mds._setMdsModelsForTests(null);
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let userId: string;
  let subject: { userId: string; email: string; username: string; orgId?: string };

  beforeEach(async () => {
    for (const model of [m.User, m.WebAuthnCredential, m.Organization, m.UserOrganization]) await model.deleteMany({});
    mds._setMdsModelsForTests(null);
    const user = await m.User.create({ username: 'passkey-user', email: 'passkey@example.com', password: 'Passw0rdPassw0rd', isEmailVerified: true });
    userId = String(user._id);
    subject = { userId, email: 'passkey@example.com', username: 'passkey-user' };
  });

  const newAuthenticator = (aaguid?: string) => new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN, ...(aaguid ? { aaguid } : {}) });

  /** Full registration ceremony; returns the authenticator now holding a stored credential. */
  async function registerPasskey(aaguid = YUBIKEY, who = subject) {
    const auth = newAuthenticator(aaguid);
    const { ceremonyId, options } = await svc.registrationOptions(who);
    const summary = await svc.verifyRegistration(who.userId, ceremonyId, auth.register(options), 'My key');
    return { auth, summary, options };
  }

  async function signIn(auth: SoftAuthenticator, overrides: Parameters<SoftAuthenticator['assert']>[1] = {}) {
    const { ceremonyId, options } = await svc.loginOptions();
    return svc.verifyLogin(ceremonyId, auth.assert(options, overrides));
  }

  const storedCounter = async (auth: SoftAuthenticator) =>
    (await m.WebAuthnCredential.findOne({ credentialId: auth.id }).lean()).counter;

  describe('registration', () => {
    it('verifies a real none-attestation and stores the credential, its key and model', async () => {
      const { auth, summary, options } = await registerPasskey();

      // No org allowlist ⇒ the privacy-preserving default.
      expect(options.attestation).toBe('none');
      expect(options.rp.id).toBe(RP_ID);
      expect(options.authenticatorSelection.userVerification).toBe('required');

      expect(summary.name).toBe('My key');
      expect(summary.aaguid).toBe(YUBIKEY);
      expect(summary.attestationVerified).toBe(false);

      const doc = await m.WebAuthnCredential.findOne({ credentialId: auth.id }).lean();
      expect(String(doc.userId)).toBe(userId);
      expect(doc.counter).toBe(0);
      expect(doc.attestationFmt).toBe('none');
      expect(Buffer.from(doc.publicKey.buffer ?? doc.publicKey).length).toBeGreaterThan(64);

      // The user handle the authenticator was given is the account's stored one.
      const user = await m.User.findById(userId).select('+webauthnUserId').lean();
      expect(user.webauthnUserId).toBe(options.user.id);

      expect((await svc.listCredentials(userId)).map((c: { aaguid: string }) => c.aaguid)).toEqual([YUBIKEY]);
    });

    it('lists the existing credential in excludeCredentials and refuses re-enrolling it', async () => {
      const { auth } = await registerPasskey();
      const { ceremonyId, options } = await svc.registrationOptions(subject);
      expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([auth.id]);
      await expect(svc.verifyRegistration(userId, ceremonyId, auth.register(options), 'again'))
        .rejects.toThrow(errors.WEBAUTHN_CREDENTIAL_EXISTS);
      expect(await m.WebAuthnCredential.countDocuments({})).toBe(1);
    });

    it.each([
      ['a foreign origin', { origin: 'https://evil.example.com' }],
      ['another RP id', { rpId: 'evil.example.com' }],
    ])('refuses a response bound to %s', async (_label, overrides) => {
      const { ceremonyId, options } = await svc.registrationOptions(subject);
      await expect(svc.verifyRegistration(userId, ceremonyId, newAuthenticator(YUBIKEY).register(options, overrides), 'k'))
        .rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
      expect(await m.WebAuthnCredential.countDocuments({})).toBe(0);
    });

    it('refuses a response signed over ANOTHER ceremony\'s challenge', async () => {
      const first = await svc.registrationOptions(subject);
      const second = await svc.registrationOptions(subject);
      await expect(svc.verifyRegistration(userId, second.ceremonyId, newAuthenticator().register(first.options), 'k'))
        .rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
    });

    it('refuses an authenticator that did not verify the user (UP only)', async () => {
      const presenceOnly = new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN, userVerified: false });
      const { ceremonyId, options } = await svc.registrationOptions(subject);
      await expect(svc.verifyRegistration(userId, ceremonyId, presenceOnly.register(options), 'k'))
        .rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
    });

    it('consumes the ceremony once, and only for the user who started it', async () => {
      const other = await m.User.create({ username: 'other', email: 'other@example.com', password: 'Passw0rdPassw0rd', isEmailVerified: true });
      const { ceremonyId, options } = await svc.registrationOptions(subject);
      const response = newAuthenticator().register(options);

      // Another account presenting the ceremony id: refused — and it burned the ceremony.
      await expect(svc.verifyRegistration(String(other._id), ceremonyId, response, 'k')).rejects.toThrow(errors.WEBAUTHN_INVALID_CEREMONY);
      await expect(svc.verifyRegistration(userId, ceremonyId, response, 'k')).rejects.toThrow(errors.WEBAUTHN_INVALID_CEREMONY);
      expect(await m.WebAuthnCredential.countDocuments({})).toBe(0);
    });
  });

  describe('sign-in', () => {
    it('resolves the account from a discoverable credential and advances the stored counter', async () => {
      const { auth, summary } = await registerPasskey();

      const first = await signIn(auth);
      expect(first).toMatchObject({ userId, credentialId: auth.id, aaguid: YUBIKEY, id: summary.id });
      expect(await storedCounter(auth)).toBe(1);

      await signIn(auth);
      expect(await storedCounter(auth)).toBe(2);
      const doc = await m.WebAuthnCredential.findOne({ credentialId: auth.id }).lean();
      expect(doc.lastUsedAt).toBeInstanceOf(Date);
    });

    it('refuses a stale counter (a cloned authenticator) and leaves the stored one untouched', async () => {
      const { auth } = await registerPasskey();
      await signIn(auth);
      await signIn(auth);
      expect(await storedCounter(auth)).toBe(2);

      await expect(signIn(auth, { counter: 2 })).rejects.toThrow();
      await expect(signIn(auth, { counter: 1 })).rejects.toThrow();
      expect(await storedCounter(auth)).toBe(2);
    });

    // Regression: @simplewebauthn refuses a stale counter first; the service now
    // maps that to WEBAUTHN_COUNTER_REGRESSION so the clone_suspected audit fires.
    it('classifies a stale counter as WEBAUTHN_COUNTER_REGRESSION (the clone signal)', async () => {
      const { auth } = await registerPasskey();
      await signIn(auth);
      await expect(signIn(auth, { counter: 1 })).rejects.toThrow(errors.WEBAUTHN_COUNTER_REGRESSION);
    });

    it('refuses a captured assertion replayed into a fresh ceremony (challenge mismatch)', async () => {
      const { auth } = await registerPasskey();
      const a = await svc.loginOptions();
      const captured = auth.assert(a.options);
      await svc.verifyLogin(a.ceremonyId, captured);

      // Same ceremony again: consumed.
      await expect(svc.verifyLogin(a.ceremonyId, captured)).rejects.toThrow(errors.WEBAUTHN_INVALID_CEREMONY);
      // A new ceremony: signed over the old challenge.
      const b = await svc.loginOptions();
      await expect(svc.verifyLogin(b.ceremonyId, captured)).rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
      expect(await storedCounter(auth)).toBe(1);
    });

    it('refuses an assertion from a foreign origin', async () => {
      const { auth } = await registerPasskey();
      await expect(signIn(auth, { origin: 'https://evil.example.com' })).rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
      expect(await storedCounter(auth)).toBe(0);
    });

    it('refuses an assertion whose user handle is not the account\'s (or is missing)', async () => {
      const { auth } = await registerPasskey();
      await expect(signIn(auth, { userHandle: Buffer.alloc(32, 7).toString('base64url') })).rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
      await expect(signIn(auth, { userHandle: null })).rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
      // The precheck refused BEFORE anything was written.
      expect(await storedCounter(auth)).toBe(0);
    });

    it('refuses an unknown credential', async () => {
      await expect(signIn(newAuthenticator())).rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
    });

    it('refuses a sign-in challenge redeemed as a step-up (separate ceremony spaces)', async () => {
      const { auth } = await registerPasskey();
      const login = await svc.loginOptions();
      await expect(svc.verifyStepUp(userId, login.ceremonyId, auth.assert(login.options))).rejects.toThrow(errors.WEBAUTHN_INVALID_CEREMONY);
    });
  });

  describe('step-up', () => {
    it('verifies the owner\'s passkey and refuses someone else\'s', async () => {
      const mine = await registerPasskey();
      const otherUser = await m.User.create({ username: 'other', email: 'other@example.com', password: 'Passw0rdPassw0rd', isEmailVerified: true });
      const otherSubject = { userId: String(otherUser._id), email: 'other@example.com', username: 'other' };
      const theirs = await registerPasskey(YUBIKEY, otherSubject);

      const ok = await svc.stepUpOptions(userId);
      expect(ok.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([mine.auth.id]);
      await expect(svc.verifyStepUp(userId, ok.ceremonyId, mine.auth.assert(ok.options))).resolves.toMatchObject({ userId });

      // A valid assertion — for the OTHER account's passkey — never satisfies this user's step-up.
      const cross = await svc.stepUpOptions(userId);
      await expect(svc.verifyStepUp(userId, cross.ceremonyId, theirs.auth.assert(cross.options))).rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
      expect(await storedCounter(theirs.auth)).toBe(0);
    });

    it('refuses to start without any passkey', async () => {
      await expect(svc.stepUpOptions(userId)).rejects.toThrow(errors.WEBAUTHN_NO_CREDENTIALS);
    });
  });

  describe('org authenticator policy', () => {
    async function org(name: string, extra: Record<string, unknown> = {}) {
      return String((await m.Organization.create({ name, owner: new mongoose.Types.ObjectId(), tier: 'pro', ...extra }))._id);
    }

    it('asks an allowlisted org\'s registrant for DIRECT attestation and refuses an unattested (none) passkey', async () => {
      const orgId = await org('Strict', { allowedAuthenticatorAaguids: [YUBIKEY] });
      // Metadata IS available, so the refusal is about the attestation itself.
      mds._setMdsModelsForTests([{ aaguid: YUBIKEY, description: 'YubiKey 5 Series', compromised: false }]);
      const { ceremonyId, options } = await svc.registrationOptions({ ...subject, orgId });
      expect(options.attestation).toBe('direct');

      // Even an allowlisted MODEL is refused when nothing proves it is that model.
      await expect(svc.verifyRegistration(userId, ceremonyId, newAuthenticator(YUBIKEY).register(options), 'k'))
        .rejects.toThrow(errors.WEBAUTHN_ATTESTATION_UNVERIFIABLE);
      expect(await m.WebAuthnCredential.countDocuments({})).toBe(0);
    });

    it('refuses an allowlisted registration when no FIDO metadata is loaded', async () => {
      const orgId = await org('Strict', { allowedAuthenticatorAaguids: [YUBIKEY] });
      const { ceremonyId, options } = await svc.registrationOptions({ ...subject, orgId });
      await expect(svc.verifyRegistration(userId, ceremonyId, newAuthenticator(YUBIKEY).register(options), 'k'))
        .rejects.toThrow(errors.WEBAUTHN_ATTESTATION_UNVERIFIABLE);
    });

    it('applies a PARENT\'s allowlist to a team registrant (inherited, strictest wins)', async () => {
      const parent = await org('Parent', { allowedAuthenticatorAaguids: [YUBIKEY] });
      const team = await org('Team', { parentOrgId: parent });
      const { options } = await svc.registrationOptions({ ...subject, orgId: team });
      expect(options.attestation).toBe('direct');
      expect((await policy.resolveEffectiveAuthenticatorPolicy(team)).allowed).toEqual([YUBIKEY]);
    });

    it('keeps a non-allowlisted passkey working for sign-in but demotes it to aal 1 in that org', async () => {
      // Enrolled outside any allowlist (e.g. before the policy), then the org restricts models.
      const { auth } = await registerPasskey(OTHER_MODEL);
      const strict = await org('Strict', { allowedAuthenticatorAaguids: [YUBIKEY] });
      const permitsIt = await org('PermitsIt', { allowedAuthenticatorAaguids: [OTHER_MODEL] });
      const open = await org('Open');
      const team = await org('Team', { parentOrgId: strict, allowedAuthenticatorAaguids: [OTHER_MODEL] });

      // The sign-in itself is NOT refused: the credential still identifies its owner.
      const verified = await signIn(auth);
      expect(verified.aaguid).toBe(OTHER_MODEL);

      const session = { amr: ['webauthn'], aal: 2, authTime: new Date(), aaguid: verified.aaguid };
      expect((await policy.applyAuthenticatorPolicy(session, strict)).aal).toBe(1);
      expect((await policy.applyAuthenticatorPolicy(session, permitsIt)).aal).toBe(2);
      expect((await policy.applyAuthenticatorPolicy(session, open)).aal).toBe(2);
      // A team cannot WIDEN its parent's list: the intersection is empty.
      expect((await policy.resolveEffectiveAuthenticatorPolicy(team)).allowed).toEqual([]);
      expect((await policy.applyAuthenticatorPolicy(session, team)).aal).toBe(1);
    });
  });

  describe('removal', () => {
    it('removes a passkey (transactionally) when the account keeps a password', async () => {
      const { auth, summary } = await registerPasskey();
      await svc.removeCredential(userId, summary.id);
      expect(await m.WebAuthnCredential.countDocuments({})).toBe(0);
      // And it no longer signs in.
      await expect(signIn(auth)).rejects.toThrow(errors.WEBAUTHN_VERIFICATION_FAILED);
    });
  });
});
