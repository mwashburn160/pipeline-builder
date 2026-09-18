// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `webauthn-service` — the ceremony rules, with SimpleWebAuthn's cryptographic
 * verification mocked out (it has its own test suite; what matters here is what
 * we do around it):
 *   - a challenge is consume-once and bound to the user who started it;
 *   - an assertion for SOMEONE ELSE'S credential never satisfies a step-up;
 *   - passkey sign-in additionally requires the authenticator's `userHandle` to
 *     match the account's stored handle;
 *   - a signature counter that goes backwards is refused (clone signal), while a
 *     synced credential's permanent 0 is fine;
 *   - the last-sign-in-method guard, in every combination;
 *   - `webauthnUserId` is minted exactly once under concurrency.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';

// The service reads `config` for the relying party and the ceremony TTL, and
// config refuses to load without the deployment secrets.
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

// -- SimpleWebAuthn (mocked) ---------------------------------------------------
const mockVerifyRegistration = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockVerifyAuthentication = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@simplewebauthn/server', () => ({
  generateRegistrationOptions: async (opts: Record<string, unknown>) => ({ challenge: 'reg-challenge', ...opts }),
  generateAuthenticationOptions: async (opts: Record<string, unknown>) => ({ challenge: 'auth-challenge', ...opts }),
  verifyRegistrationResponse: (...a: unknown[]) => mockVerifyRegistration(...a),
  verifyAuthenticationResponse: (...a: unknown[]) => mockVerifyAuthentication(...a),
}));

// -- Models (in-memory stand-ins) ---------------------------------------------
interface Cred {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  backedUp: boolean;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}
let creds: Cred[] = [];
let users: Record<string, { password?: string; oauth?: Record<string, { id?: string }>; webauthnUserId?: string; email: string; username: string }> = {};

/** Only the (few, exact) filter shapes the service uses. */
function match(c: Cred, filter: Record<string, unknown>): boolean {
  if (filter.credentialId !== undefined && c.credentialId !== filter.credentialId) return false;
  if (filter.userId !== undefined && c.userId.toString() !== String(filter.userId)) return false;
  if (filter._id !== undefined && c._id.toString() !== String(filter._id)) return false;
  return true;
}
const chainable = <T>(value: T) => {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'sort']) self[m] = () => self;
  self.lean = async () => value;
  self.then = (res: (v: T) => unknown) => Promise.resolve(value).then(res);
  return self as never;
};

jest.unstable_mockModule('../src/models/index.js', () => ({
  // The last-sign-in-method guard reads through `helpers/sign-in-methods`, which
  // asks whether the account has a CONFIRMED authenticator app. It is never one
  // here: TOTP is a SECOND factor, so it can never be what keeps an account
  // reachable after its last passkey goes.
  UserTotp: { exists: async () => null },
  WebAuthnCredential: {
    find: (f: Record<string, unknown>) => chainable(creds.filter((c) => match(c, f))),
    findOne: (f: Record<string, unknown>) => chainable(creds.find((c) => match(c, f)) ?? null),
    countDocuments: async (f: Record<string, unknown>) => creds.filter((c) => match(c, f)).length,
    exists: async (f: Record<string, unknown>) => (creds.find((c) => match(c, f)) ? { _id: 'x' } : null),
    create: async (doc: Record<string, unknown>) => {
      if (creds.some((c) => c.credentialId === doc.credentialId)) {
        throw Object.assign(new Error('E11000'), { code: 11000 });
      }
      const created = { _id: new Types.ObjectId(), lastUsedAt: null, ...doc } as unknown as Cred;
      creds.push(created);
      return created;
    },
    updateOne: async (f: Record<string, unknown>, update: { $set: Partial<Cred> }) => {
      const c = creds.find((x) => match(x, f));
      if (c) Object.assign(c, update.$set);
      return { modifiedCount: c ? 1 : 0 };
    },
    findOneAndUpdate: (f: Record<string, unknown>, update: { $set: Partial<Cred> }) => {
      const c = creds.find((x) => match(x, f));
      if (c) Object.assign(c, update.$set);
      return chainable(c ?? null);
    },
    deleteOne: async (f: Record<string, unknown>) => {
      const before = creds.length;
      creds = creds.filter((c) => !match(c, f));
      return { deletedCount: before - creds.length };
    },
  },
  User: {
    findById: (id: string) => chainable(users[String(id)] ?? null),
    findOneAndUpdate: (f: { _id: string; webauthnUserId?: unknown }, update: { $set: { webauthnUserId: string } }) => {
      const u = users[String(f._id)];
      // Mirrors the real `{ $exists: false }` filter: the write lands only while
      // the handle is still unset, which is what makes the mint atomic.
      if (u && u.webauthnUserId === undefined) u.webauthnUserId = update.$set.webauthnUserId;
      return chainable(u && u.webauthnUserId !== undefined ? { webauthnUserId: u.webauthnUserId } : null);
    },
  },
}));

const svc = await import('../src/services/webauthn-service.js');
const E = await import('../src/services/webauthn-errors.js');

const OWNER = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const ownerId = OWNER.toString();

function addCred(over: Partial<Cred> = {}): Cred {
  const c: Cred = {
    _id: new Types.ObjectId(),
    userId: OWNER,
    credentialId: `cred-${creds.length}`,
    publicKey: Buffer.from([1, 2, 3]),
    counter: 0,
    transports: ['internal'],
    backedUp: true,
    name: 'Laptop',
    createdAt: new Date(),
    lastUsedAt: null,
    ...over,
  };
  creds.push(c);
  return c;
}

const assertionResponse = (credentialId: string, userHandle?: string) => ({
  id: credentialId,
  rawId: credentialId,
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: '', authenticatorData: '', signature: '', ...(userHandle ? { userHandle } : {}) },
}) as never;

const authInfo = (newCounter: number) => ({
  verified: true,
  authenticationInfo: { credentialID: 'x', newCounter, userVerified: true, credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: '', rpID: '' },
});

beforeEach(() => {
  jest.clearAllMocks();
  svc._resetCeremoniesForTests();
  creds = [];
  users = {
    [ownerId]: { email: 'owner@example.com', username: 'owner', oauth: {} },
    [OTHER.toString()]: { email: 'other@example.com', username: 'other', oauth: {} },
  };
  mockVerifyAuthentication.mockResolvedValue(authInfo(1));
  mockVerifyRegistration.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: 'new-cred', publicKey: new Uint8Array([9, 9]), counter: 0, transports: ['internal'] },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      aaguid: 'aaguid-1',
    },
  });
});

const subject = { userId: ownerId, email: 'owner@example.com', username: 'owner' };

describe('registration', () => {
  it('offers the account\'s existing credentials as excludeCredentials, so the same device can\'t enrol twice', async () => {
    addCred({ credentialId: 'already-here' });
    const { options } = await svc.registrationOptions(subject);
    expect((options as unknown as { excludeCredentials: Array<{ id: string }> }).excludeCredentials)
      .toEqual([{ id: 'already-here', transports: ['internal'] }]);
  });

  it('requires a discoverable credential with user verification', async () => {
    const { options } = await svc.registrationOptions(subject);
    expect((options as unknown as { authenticatorSelection: unknown }).authenticatorSelection)
      .toEqual({ residentKey: 'required', userVerification: 'required' });
  });

  it('stores the credential and consumes the ceremony exactly once', async () => {
    const { ceremonyId } = await svc.registrationOptions(subject);
    await expect(svc.verifyRegistration(ownerId, ceremonyId, {} as never, 'Work laptop')).resolves.toMatchObject({
      name: 'Work laptop', backedUp: true,
    });
    expect(creds).toHaveLength(1);
    // A replay of the same ceremony finds nothing to consume.
    await expect(svc.verifyRegistration(ownerId, ceremonyId, {} as never, 'again'))
      .rejects.toThrow(E.WEBAUTHN_INVALID_CEREMONY);
  });

  it('refuses a ceremony started by another user', async () => {
    const { ceremonyId } = await svc.registrationOptions(subject);
    await expect(svc.verifyRegistration(OTHER.toString(), ceremonyId, {} as never, 'x'))
      .rejects.toThrow(E.WEBAUTHN_INVALID_CEREMONY);
  });

  it('refuses an authenticator already registered (here or on another account)', async () => {
    addCred({ userId: OTHER, credentialId: 'new-cred' });
    const { ceremonyId } = await svc.registrationOptions(subject);
    await expect(svc.verifyRegistration(ownerId, ceremonyId, {} as never, 'x'))
      .rejects.toThrow(E.WEBAUTHN_CREDENTIAL_EXISTS);
  });

  it('refuses an unverified response', async () => {
    mockVerifyRegistration.mockResolvedValue({ verified: false });
    const { ceremonyId } = await svc.registrationOptions(subject);
    await expect(svc.verifyRegistration(ownerId, ceremonyId, {} as never, 'x'))
      .rejects.toThrow(E.WEBAUTHN_VERIFICATION_FAILED);
  });
});

describe('webauthnUserId', () => {
  it('is minted once, even when two registrations race', async () => {
    const [a, b] = await Promise.all([svc.ensureWebAuthnUserId(ownerId), svc.ensureWebAuthnUserId(ownerId)]);
    expect(a).toBe(b);
    expect(users[ownerId].webauthnUserId).toBe(a);
  });
});

describe('step-up assertion', () => {
  it('refuses when the account has no passkey', async () => {
    await expect(svc.stepUpOptions(ownerId)).rejects.toThrow(E.WEBAUTHN_NO_CREDENTIALS);
  });

  it('verifies, advances the counter and records the use', async () => {
    const c = addCred({ counter: 4 });
    mockVerifyAuthentication.mockResolvedValue(authInfo(5));
    const { ceremonyId } = await svc.stepUpOptions(ownerId);
    await expect(svc.verifyStepUp(ownerId, ceremonyId, assertionResponse(c.credentialId))).resolves.toMatchObject({ userId: ownerId });
    expect(creds[0].counter).toBe(5);
    expect(creds[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('requires user verification of the library', async () => {
    const c = addCred();
    const { ceremonyId } = await svc.stepUpOptions(ownerId);
    await svc.verifyStepUp(ownerId, ceremonyId, assertionResponse(c.credentialId));
    expect(mockVerifyAuthentication).toHaveBeenCalledWith(expect.objectContaining({ requireUserVerification: true }));
  });

  it('refuses a credential belonging to another user', async () => {
    const theirs = addCred({ userId: OTHER, credentialId: 'theirs' });
    addCred({ credentialId: 'mine' });
    const { ceremonyId } = await svc.stepUpOptions(ownerId);
    await expect(svc.verifyStepUp(ownerId, ceremonyId, assertionResponse(theirs.credentialId)))
      .rejects.toThrow(E.WEBAUTHN_VERIFICATION_FAILED);
  });

  it('refuses an unknown credential', async () => {
    addCred();
    const { ceremonyId } = await svc.stepUpOptions(ownerId);
    await expect(svc.verifyStepUp(ownerId, ceremonyId, assertionResponse('nope')))
      .rejects.toThrow(E.WEBAUTHN_VERIFICATION_FAILED);
  });
});

describe('counter policy', () => {
  it('accepts a synced credential that always reports 0', () => {
    expect(() => svc.assertCounterProgressed(0, 0)).not.toThrow();
  });

  it('accepts a counter that advances', () => {
    expect(() => svc.assertCounterProgressed(7, 8)).not.toThrow();
  });

  it('refuses a counter that stalls or goes backwards once it has counted', () => {
    expect(() => svc.assertCounterProgressed(7, 7)).toThrow(E.WEBAUTHN_COUNTER_REGRESSION);
    expect(() => svc.assertCounterProgressed(7, 3)).toThrow(E.WEBAUTHN_COUNTER_REGRESSION);
  });

  it('surfaces through a step-up assertion and leaves the stored counter untouched', async () => {
    const c = addCred({ counter: 9 });
    mockVerifyAuthentication.mockResolvedValue(authInfo(2));
    const { ceremonyId } = await svc.stepUpOptions(ownerId);
    await expect(svc.verifyStepUp(ownerId, ceremonyId, assertionResponse(c.credentialId)))
      .rejects.toThrow(E.WEBAUTHN_COUNTER_REGRESSION);
    expect(creds[0].counter).toBe(9);
  });
});

describe('passkey sign-in', () => {
  it('asks for no specific credential — the browser offers whatever it holds', async () => {
    const { options } = await svc.loginOptions();
    expect((options as unknown as { allowCredentials?: unknown }).allowCredentials).toBeUndefined();
  });

  it('resolves the user when the authenticator returns the matching user handle', async () => {
    const c = addCred();
    users[ownerId].webauthnUserId = 'handle-abc';
    const { ceremonyId } = await svc.loginOptions();
    await expect(svc.verifyLogin(ceremonyId, assertionResponse(c.credentialId, 'handle-abc')))
      .resolves.toMatchObject({ userId: ownerId });
  });

  it('refuses a mismatched or missing user handle, without touching the stored counter', async () => {
    const c = addCred({ counter: 3 });
    users[ownerId].webauthnUserId = 'handle-abc';
    const first = await svc.loginOptions();
    await expect(svc.verifyLogin(first.ceremonyId, assertionResponse(c.credentialId, 'handle-xyz')))
      .rejects.toThrow(E.WEBAUTHN_VERIFICATION_FAILED);
    const second = await svc.loginOptions();
    await expect(svc.verifyLogin(second.ceremonyId, assertionResponse(c.credentialId)))
      .rejects.toThrow(E.WEBAUTHN_VERIFICATION_FAILED);
    expect(creds[0].counter).toBe(3);
  });

  it('will not accept a step-up ceremony id (separate key spaces)', async () => {
    const c = addCred();
    const { ceremonyId } = await svc.stepUpOptions(ownerId);
    await expect(svc.verifyLogin(ceremonyId, assertionResponse(c.credentialId, 'h')))
      .rejects.toThrow(E.WEBAUTHN_INVALID_CEREMONY);
  });
});

describe('management', () => {
  it('renames only the caller\'s own passkey', async () => {
    const mine = addCred();
    const theirs = addCred({ userId: OTHER });
    await expect(svc.renameCredential(ownerId, mine._id.toString(), 'Phone')).resolves.toMatchObject({ name: 'Phone' });
    await expect(svc.renameCredential(ownerId, theirs._id.toString(), 'Hijack'))
      .rejects.toThrow(E.WEBAUTHN_CREDENTIAL_NOT_FOUND);
  });

  it('removes a passkey when a password remains', async () => {
    const c = addCred();
    users[ownerId].password = 'hash';
    await expect(svc.removeCredential(ownerId, c._id.toString())).resolves.toMatchObject({ id: c._id.toString() });
    expect(creds).toHaveLength(0);
  });

  it('removes a passkey when a linked provider remains', async () => {
    const c = addCred();
    users[ownerId].oauth = { google: { id: 'g-1' } };
    await expect(svc.removeCredential(ownerId, c._id.toString())).resolves.toBeDefined();
  });

  it('removes a passkey when another passkey remains', async () => {
    const c = addCred();
    addCred({ credentialId: 'second' });
    await expect(svc.removeCredential(ownerId, c._id.toString())).resolves.toBeDefined();
    expect(creds).toHaveLength(1);
  });

  it('refuses to remove the only way the account can sign in', async () => {
    const c = addCred();
    await expect(svc.removeCredential(ownerId, c._id.toString()))
      .rejects.toThrow(E.WEBAUTHN_LAST_SIGN_IN_METHOD);
    expect(creds).toHaveLength(1);
  });

  it('lists in registration order, without exposing the public key', async () => {
    addCred({ name: 'A' });
    addCred({ credentialId: 'b', name: 'B' });
    const listed = await svc.listCredentials(ownerId);
    expect(listed.map((p) => p.name)).toEqual(['A', 'B']);
    expect(listed[0]).not.toHaveProperty('publicKey');
  });
});
