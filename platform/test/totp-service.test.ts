// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `totp-service` — the stateful rules around the algorithm, against an in-memory
 * stand-in for the `UserTotp` collection that implements only the (few, exact)
 * query shapes the service uses.
 *
 * Deliberately NOT mocked: `utils/secret-blob` and api-core's real AES-256-GCM.
 * "The secret is encrypted at rest" is the claim most worth checking, and a
 * stubbed encryptor would check nothing — so the stored blob is asserted to be
 * unreadable as-is, to be bound to the user it belongs to, and to round-trip.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { createFakeRecoveryCodes } from './helpers/fake-recovery-codes.js';

// config refuses to load without the deployment secrets; the encryption key is
// also the one this suite actually encrypts under.
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.TOTP_MAX_FAILURES = '3';
process.env.TOTP_LOCKOUT_MS = '60000';

// -- Model stand-in ------------------------------------------------------------

interface TotpDoc {
  _id: Types.ObjectId;
  userId: string;
  secret: string;
  activatedAt: Date | null;
  lastUsedStep: number;
  failedAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

let docs: TotpDoc[] = [];
let users: Record<string, { email: string }> = {};
/** The account's recovery codes live in their own collection (one set per
 *  account, shared with passkeys) — real service, in-memory collection. */
const recovery = createFakeRecoveryCodes();
let passkeys = 0;

/** The filter shapes the service uses, and nothing else. */
function findDoc(filter: Record<string, unknown>): { doc: TotpDoc; recoveryIndex: number } | null {
  for (const doc of docs) {
    if (filter.userId !== undefined && doc.userId !== String(filter.userId)) continue;
    if (filter.activatedAt !== undefined && doc.activatedAt === null) continue;
    if (filter.lastUsedStep !== undefined && doc.lastUsedStep !== filter.lastUsedStep) continue;
    return { doc, recoveryIndex: -1 };
  }
  return null;
}

/** Apply `$set` and `$inc`. */
function applyUpdate(doc: TotpDoc, update: Record<string, unknown>, _recoveryIndex: number): void {
  const set = (update.$set ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(set)) {
    (doc as unknown as Record<string, unknown>)[key] = value;
  }
  for (const [key, value] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
    (doc as unknown as Record<string, number>)[key] = ((doc as unknown as Record<string, number>)[key] ?? 0) + value;
  }
}

/** A `.select().lean()` / thenable chain over a fixed value, as mongoose returns. */
const chainable = <T>(value: T) => {
  const self: Record<string, unknown> = {};
  self.select = () => self;
  self.lean = async () => value;
  self.then = (res: (v: T) => unknown) => Promise.resolve(value).then(res);
  return self as never;
};

jest.unstable_mockModule('../src/models/index.js', () => ({
  UserTotp: {
    exists: async (f: Record<string, unknown>) => (findDoc(f) ? { _id: 'x' } : null),
    findOne: (f: Record<string, unknown>) => chainable(findDoc(f)?.doc ?? null),
    deleteOne: async (f: Record<string, unknown>) => {
      const before = docs.length;
      docs = docs.filter((d) => !(findDoc(f)?.doc === d));
      return { deletedCount: before - docs.length };
    },
    updateOne: async (f: Record<string, unknown>, update: Record<string, unknown>) => {
      const found = findDoc(f);
      if (found) applyUpdate(found.doc, update, found.recoveryIndex);
      return { modifiedCount: found ? 1 : 0 };
    },
    findOneAndUpdate: (
      f: Record<string, unknown>,
      update: Record<string, unknown>,
      opts: { upsert?: boolean } = {},
    ) => {
      let found = findDoc(f);
      if (!found && opts.upsert) {
        const created: TotpDoc = {
          _id: new Types.ObjectId(),
          userId: String(f.userId),
          secret: '',
          activatedAt: null,
          lastUsedStep: 0,
          failedAttempts: 0,
          lockedUntil: null,
          createdAt: new Date(),
          lastUsedAt: null,
          ...((update.$setOnInsert ?? {}) as Partial<TotpDoc>),
        };
        docs.push(created);
        found = { doc: created, recoveryIndex: -1 };
      }
      if (!found) return chainable(null);
      applyUpdate(found.doc, update, found.recoveryIndex);
      return chainable(found.doc);
    },
  },
  User: {
    findById: (id: string) => chainable(users[String(id)] ?? null),
  },
  MfaRecoveryCodes: recovery.model,
  WebAuthnCredential: { countDocuments: async () => passkeys },
}));

// SSO enforcement pulls in the org/IdP/entitlement graph; only the ANSWER matters here.
const mockSsoEnforcement = jest.fn<(email: string) => Promise<unknown>>(async () => null);
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  findSsoEnforcementForEmail: (email: string) => mockSsoEnforcement(email),
}));

// The last-factor guard has its own suite; here it only needs to say yes or no.
const mockMethods = jest.fn(() => ({ hasPassword: true, hasProvider: false, passkeyCount: 0, hasTotp: true }));
const mockRetains = jest.fn(() => true);
jest.unstable_mockModule('../src/helpers/sign-in-methods.js', () => ({
  loadSignInMethods: async () => mockMethods(),
  retainsSignInMethod: () => mockRetains(),
}));

const totp = await import('../src/services/totp-service.js');
const recoveryService = await import('../src/services/recovery-codes-service.js');
const errors = await import('../src/services/totp-errors.js');
const { totpCodeForStep, timeStepAt, hashRecoveryCode } = await import('../src/utils/totp.js');
const { unwrapEncrypted } = await import('../src/utils/secret-blob.js');

const USER = new Types.ObjectId().toString();

/** The stored document, as the collection actually holds it. */
function stored(): TotpDoc {
  const doc = docs.find((d) => d.userId === USER);
  if (!doc) throw new Error('no enrolment');
  return doc;
}

/** The code the person's app would show right now. */
async function currentCode(): Promise<string> {
  const secret = await unwrapEncrypted(stored().secret, `user:${USER}`, 'totp.secret');
  return totpCodeForStep(secret, timeStepAt());
}

/** Enrol and confirm, returning the recovery codes. */
async function enrolAndActivate(): Promise<string[]> {
  await totp.beginEnrolment(USER);
  const { recoveryCodes } = await totp.activate(USER, await currentCode());
  return recoveryCodes;
}

beforeEach(() => {
  docs = [];
  recovery.reset();
  passkeys = 0;
  users = { [USER]: { email: 'person@example.com' } };
  mockSsoEnforcement.mockResolvedValue(null);
  mockRetains.mockReturnValue(true);
});

describe('enrolment', () => {
  it('stores the secret ENCRYPTED, bound to the user, and never in clear text', async () => {
    const { secret, otpauthUri } = await totp.beginEnrolment(USER);

    const blob = stored().secret;
    expect(blob).not.toContain(secret);
    // A well-formed EncryptedBlob, not a string that merely looks scrambled.
    const parsed = JSON.parse(blob);
    expect(parsed.alg).toBe('aes-256-gcm-v1');
    expect(typeof parsed.iv).toBe('string');

    // Round-trips under the OWNER's context...
    expect(await unwrapEncrypted(blob, `user:${USER}`, 'totp.secret')).toBe(secret);
    // ...and is useless under anyone else's, so a lifted row can't be replayed.
    await expect(unwrapEncrypted(blob, `user:${new Types.ObjectId().toString()}`, 'totp.secret'))
      .rejects.toThrow();

    expect(otpauthUri).toContain(`secret=${secret}`);
  });

  it('is not a factor until a code confirms it', async () => {
    await totp.beginEnrolment(USER);
    expect(await totp.hasActiveTotp(USER)).toBe(false);
    expect((await totp.getStatus(USER))).toMatchObject({ enabled: false, pending: true });

    await totp.activate(USER, await currentCode());
    expect(await totp.hasActiveTotp(USER)).toBe(true);
    expect((await totp.getStatus(USER))).toMatchObject({ enabled: true, pending: false });
  });

  it('replaces an abandoned enrolment with a NEW secret', async () => {
    const first = await totp.beginEnrolment(USER);
    const second = await totp.beginEnrolment(USER);
    expect(second.secret).not.toBe(first.secret);
    // The displayed-then-abandoned secret must not be the one that confirms.
    await expect(totp.activate(USER, totpCodeForStep(first.secret, timeStepAt())))
      .rejects.toThrow(errors.TOTP_INVALID_CODE);
  });

  it('refuses to re-enrol over a working authenticator', async () => {
    await enrolAndActivate();
    await expect(totp.beginEnrolment(USER)).rejects.toThrow(errors.TOTP_ALREADY_ENROLLED);
  });

  it('refuses enrolment for an SSO-enforced address', async () => {
    mockSsoEnforcement.mockResolvedValue({ orgId: 'o1', provider: 'cognito' });
    await expect(totp.beginEnrolment(USER)).rejects.toThrow(errors.TOTP_SSO_ENFORCED);
    expect(docs).toHaveLength(0);
  });

  it('mints ten recovery codes on activation when it is the FIRST factor, stored only as hashes', async () => {
    const codes = await enrolAndActivate();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const set = recovery.of(USER)!;
    const hashes = set.codes.map((c) => c.hash);
    for (const code of codes) {
      expect(JSON.stringify(set.codes)).not.toContain(code);
      expect(hashes).toContain(hashRecoveryCode(code));
    }
  });

  it('keeps the existing set (and returns none) when a passkey came first — one set per account', async () => {
    passkeys = 1;
    const fromPasskey = await recoveryService.issueRecoveryCodesIfAbsent(USER);
    expect(fromPasskey).toHaveLength(10);

    const codes = await enrolAndActivate();
    expect(codes).toEqual([]);
    // The passkey's sheet still works — through the authenticator's verification.
    expect((await totp.verifyCode(USER, fromPasskey![0])).method).toBe('recovery');
  });
});

describe('code verification', () => {
  it('accepts the current code and one step of drift', async () => {
    await enrolAndActivate();
    const secret = await unwrapEncrypted(stored().secret, `user:${USER}`, 'totp.secret');
    // Activation consumed the current step, so the NEXT one is what is live.
    const next = timeStepAt() + 1;
    stored().lastUsedStep = next - 2;
    expect((await totp.verifyCode(USER, totpCodeForStep(secret, next))).method).toBe('totp');
  });

  it('refuses a code already spent (same step, twice)', async () => {
    await totp.beginEnrolment(USER);
    const code = await currentCode();
    await totp.activate(USER, code);
    // The step activation consumed cannot be spent again — this is the defence
    // against a phishing proxy replaying the code it just relayed.
    await expect(totp.verifyCode(USER, code)).rejects.toThrow(errors.TOTP_INVALID_CODE);
  });

  it('refuses a code from an EARLIER step even inside the drift window', async () => {
    await enrolAndActivate();
    const secret = await unwrapEncrypted(stored().secret, `user:${USER}`, 'totp.secret');
    await expect(totp.verifyCode(USER, totpCodeForStep(secret, timeStepAt() - 1)))
      .rejects.toThrow(errors.TOTP_INVALID_CODE);
  });

  it('refuses everything when there is no ACTIVE enrolment', async () => {
    await totp.beginEnrolment(USER);
    await expect(totp.verifyCode(USER, await currentCode())).rejects.toThrow(errors.TOTP_NOT_ENROLLED);
  });
});

describe('recovery codes', () => {
  it('are accepted wherever a generated code is, exactly once', async () => {
    const codes = await enrolAndActivate();
    const first = await totp.verifyCode(USER, codes[0]);
    expect(first).toEqual({ method: 'recovery', recoveryCodesRemaining: 9 });
    // Spent, so it is refused as spent rather than silently working again.
    await expect(totp.verifyCode(USER, codes[0])).rejects.toThrow(errors.TOTP_INVALID_CODE);
    // ...and a different one still works.
    expect((await totp.verifyCode(USER, codes[1])).recoveryCodesRemaining).toBe(8);
  });

  it('are accepted however the person types them', async () => {
    const codes = await enrolAndActivate();
    expect((await totp.verifyCode(USER, codes[0].toLowerCase())).method).toBe('recovery');
    expect((await totp.verifyCode(USER, codes[1].replace('-', ' '))).method).toBe('recovery');
  });

  it('regeneration invalidates every previous code, used or not', async () => {
    const old = await enrolAndActivate();
    await totp.verifyCode(USER, old[0]);
    const { recoveryCodes: fresh } = await recoveryService.regenerateRecoveryCodes(USER);

    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => old.includes(c))).toBe(false);
    // An UNUSED old code is now worthless.
    await expect(totp.verifyCode(USER, old[1])).rejects.toThrow(errors.TOTP_INVALID_CODE);
    expect((await totp.verifyCode(USER, fresh[0])).recoveryCodesRemaining).toBe(9);
  });

  it('cannot be regenerated without a second factor', async () => {
    await expect(recoveryService.regenerateRecoveryCodes(USER)).rejects.toThrow(recoveryService.RECOVERY_CODES_NO_FACTOR);
  });

  it('are counted in the status view', async () => {
    const codes = await enrolAndActivate();
    await totp.verifyCode(USER, codes[0]);
    expect(await totp.getStatus(USER)).toMatchObject({
      enabled: true, recoveryCodesRemaining: 9, recoveryCodesTotal: 10,
    });
  });
});

describe('lockout', () => {
  it('refuses everything after the configured run of failures', async () => {
    await enrolAndActivate();
    // TOTP_MAX_FAILURES is 3 in this suite.
    for (let i = 0; i < 3; i++) {
      await expect(totp.verifyCode(USER, '000000')).rejects.toThrow(errors.TOTP_INVALID_CODE);
    }
    expect(stored().lockedUntil).toBeInstanceOf(Date);

    // Even a CORRECT code is refused while the lockout stands — that is the
    // point: the 6-digit space is small, so the limit must not be per-guess.
    const secret = await unwrapEncrypted(stored().secret, `user:${USER}`, 'totp.secret');
    await expect(totp.verifyCode(USER, totpCodeForStep(secret, timeStepAt() + 1)))
      .rejects.toThrow(errors.TOTP_LOCKED_OUT);
    expect((await totp.getStatus(USER)).lockedUntil).toBeInstanceOf(Date);
  });

  it('lifts once it expires, and a success resets the run', async () => {
    await enrolAndActivate();
    for (let i = 0; i < 2; i++) {
      await expect(totp.verifyCode(USER, '000000')).rejects.toThrow(errors.TOTP_INVALID_CODE);
    }
    expect(stored().failedAttempts).toBe(2);

    const secret = await unwrapEncrypted(stored().secret, `user:${USER}`, 'totp.secret');
    await totp.verifyCode(USER, totpCodeForStep(secret, timeStepAt() + 1));
    expect(stored().failedAttempts).toBe(0);
    expect(stored().lockedUntil).toBeNull();
  });

  it('is shared with recovery codes — guessing one does not get a fresh budget', async () => {
    await enrolAndActivate();
    for (let i = 0; i < 3; i++) {
      await expect(totp.verifyCode(USER, 'AAAAA-AAAAA')).rejects.toThrow(errors.TOTP_INVALID_CODE);
    }
    expect(stored().lockedUntil).toBeInstanceOf(Date);
  });

  it('blocks confirming an enrolment too', async () => {
    await totp.beginEnrolment(USER);
    for (let i = 0; i < 3; i++) {
      await expect(totp.activate(USER, '000000')).rejects.toThrow(errors.TOTP_INVALID_CODE);
    }
    await expect(totp.activate(USER, await currentCode())).rejects.toThrow(errors.TOTP_LOCKED_OUT);
  });
});

describe('disable', () => {
  it('removes the enrolment and — with no passkey left — every recovery code with it', async () => {
    const codes = await enrolAndActivate();
    await totp.disable(USER);
    expect(docs).toHaveLength(0);
    expect(await totp.hasActiveTotp(USER)).toBe(false);
    expect(recovery.of(USER)).toBeUndefined();
    await expect(totp.verifyCode(USER, codes[0])).rejects.toThrow(errors.TOTP_NOT_ENROLLED);
  });

  it('keeps the recovery codes while a passkey still backs the account', async () => {
    await enrolAndActivate();
    passkeys = 1;
    await totp.disable(USER);
    expect(recovery.of(USER)?.codes).toHaveLength(10);
  });

  it('is refused when it would leave no way to sign in', async () => {
    await enrolAndActivate();
    mockRetains.mockReturnValue(false);
    await expect(totp.disable(USER)).rejects.toThrow(errors.TOTP_LAST_SIGN_IN_METHOD);
    // Nothing destroyed on the refused path.
    expect(await totp.hasActiveTotp(USER)).toBe(true);
  });

  it('refuses when there is nothing enrolled', async () => {
    await expect(totp.disable(USER)).rejects.toThrow(errors.TOTP_NOT_ENROLLED);
  });
});
