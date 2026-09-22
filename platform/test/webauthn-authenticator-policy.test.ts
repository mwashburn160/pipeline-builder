// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey REGISTRATION under an org authenticator (AAGUID) allowlist: the
 * ceremony asks for DIRECT attestation, and verify refuses a registration whose
 * model is not allowlisted, is reported compromised, or whose attestation can't
 * be tied to a model the FIDO Metadata Service knows (none / self attestation,
 * unknown AAGUID, no metadata loaded). SimpleWebAuthn's own verification is
 * mocked — it has its own suite; this is what we do around it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const YUBIKEY = 'cb69481e-8ff7-4039-93ec-0a2729a154a8';
const TITAN = '42b4fb4a-2866-43b2-9bf7-6c6669c2e5d3';

const mockGenerateRegistrationOptions = jest.fn(async (opts: Record<string, unknown>) => ({ challenge: 'reg-challenge', ...opts }));
const mockVerifyRegistration = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  generateAuthenticationOptions: async () => ({ challenge: 'auth' }),
  verifyRegistrationResponse: (...a: unknown[]) => mockVerifyRegistration(...a),
  verifyAuthenticationResponse: async () => ({ verified: false }),
}));
let x5c: unknown[] | undefined = [new Uint8Array([1])];
jest.unstable_mockModule('@simplewebauthn/server/helpers', () => ({
  decodeAttestationObject: () => ({ get: (k: string) => (k === 'attStmt' ? { get: (f: string) => (f === 'x5c' ? x5c : undefined) } : undefined) }),
}));

let mdsLoaded = true;
const models: Record<string, { aaguid: string; description: string; compromised: boolean }> = {
  [YUBIKEY]: { aaguid: YUBIKEY, description: 'YubiKey 5 Series', compromised: false },
  [TITAN]: { aaguid: TITAN, description: 'Titan', compromised: true },
};
jest.unstable_mockModule('../src/services/fido-mds.js', () => ({
  ensureMds: async () => (mdsLoaded ? { models: new Map() } : null),
  lookupModel: async (aaguid: string) => (mdsLoaded ? models[aaguid] : null),
}));

let allowlist: string[] | undefined;
jest.unstable_mockModule('../src/helpers/org-policy-lineage.js', () => ({
  readOrgPolicyLineage: async (orgId: string) => [{ _id: orgId, ...(allowlist ? { allowedAuthenticatorAaguids: allowlist } : {}) }],
}));

const stored: Array<Record<string, unknown>> = [];
const chainable = <T>(value: T) => {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'sort']) self[m] = () => self;
  self.lean = async () => value;
  return self as never;
};
jest.unstable_mockModule('../src/models/index.js', () => ({
  UserTotp: { exists: async () => null },
  WebAuthnCredential: {
    find: () => chainable([]),
    exists: async () => null,
    create: async (doc: Record<string, unknown>) => {
      const created = { _id: new Types.ObjectId(), lastUsedAt: null, ...doc };
      stored.push(created);
      return created;
    },
  },
  User: {
    findOneAndUpdate: () => chainable({ webauthnUserId: 'aGFuZGxl' }),
    findById: () => chainable({ webauthnUserId: 'aGFuZGxl' }),
  },
}));

const { _resetAllPendingStoresForTests } = await import('../src/helpers/pending-state-store.js');
const svc = await import('../src/services/webauthn-service.js');
const E = await import('../src/services/webauthn-errors.js');

const OWNER = new Types.ObjectId().toString();
const subject = { userId: OWNER, email: 'o@example.com', username: 'owner', orgId: 'org-1' };

function registration(aaguid: string, fmt = 'packed') {
  mockVerifyRegistration.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: `cred-${stored.length}`, publicKey: new Uint8Array([9]), counter: 0, transports: ['usb'] },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      aaguid,
      fmt,
      attestationObject: new Uint8Array([0]),
    },
  });
}

async function enrol(): Promise<unknown> {
  const { ceremonyId } = await svc.registrationOptions(subject);
  return svc.verifyRegistration(OWNER, ceremonyId, {} as never, 'Key');
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAllPendingStoresForTests();
  stored.length = 0;
  allowlist = [YUBIKEY, TITAN];
  mdsLoaded = true;
  x5c = [new Uint8Array([1])];
});

describe('registration under an authenticator allowlist', () => {
  it('asks for DIRECT attestation only when the active org allowlists models', async () => {
    await svc.registrationOptions(subject);
    expect(mockGenerateRegistrationOptions).toHaveBeenLastCalledWith(expect.objectContaining({ attestationType: 'direct' }));
    allowlist = undefined;
    await svc.registrationOptions(subject);
    expect(mockGenerateRegistrationOptions).toHaveBeenLastCalledWith(expect.objectContaining({ attestationType: 'none' }));
  });

  it('stores an allowlisted, MDS-known model with a verified attestation', async () => {
    registration(YUBIKEY.toUpperCase());
    await expect(enrol()).resolves.toMatchObject({ aaguid: YUBIKEY, attestationVerified: true });
    expect(stored[0]).toMatchObject({ aaguid: YUBIKEY, attestationFmt: 'packed', attestationVerified: true });
  });

  it('refuses a model that is not on the list', async () => {
    allowlist = [TITAN];
    registration(YUBIKEY);
    await expect(enrol()).rejects.toThrow(E.WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED);
    expect(stored).toHaveLength(0);
  });

  it('refuses a model MDS reports compromised, even when allowlisted', async () => {
    registration(TITAN);
    await expect(enrol()).rejects.toThrow(E.WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED);
  });

  it.each([
    ['no attestation (fmt none)', () => registration(YUBIKEY, 'none')],
    ['self attestation (no certificate chain)', () => { x5c = undefined; registration(YUBIKEY); }],
    ['a model MDS does not know', () => registration('11111111-2222-3333-4444-555555555555')],
  ])('refuses %s as unverifiable', async (_label, arrange) => {
    allowlist = [YUBIKEY, '11111111-2222-3333-4444-555555555555'];
    arrange();
    await expect(enrol()).rejects.toThrow(E.WEBAUTHN_ATTESTATION_UNVERIFIABLE);
  });

  it('refuses outright when no FIDO metadata could be loaded (fail closed)', async () => {
    mdsLoaded = false;
    registration(YUBIKEY);
    await expect(enrol()).rejects.toThrow(E.WEBAUTHN_ATTESTATION_UNVERIFIABLE);
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('without an allowlist, any model registers and nothing is checked against MDS', async () => {
    allowlist = undefined;
    mdsLoaded = false;
    registration(TITAN, 'none');
    await expect(enrol()).resolves.toMatchObject({ aaguid: TITAN, attestationVerified: false });
  });
});
