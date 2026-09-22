// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared last-factor guard (`helpers/sign-in-methods`), which both the
 * passkey removal and the TOTP disable ask before destroying a credential.
 *
 * The rule it encodes, and the reason it is shared rather than written twice:
 * a SIGN-IN method opens a session on its own (password, linked provider,
 * passkey); TOTP does NOT — it is a second factor on a password sign-in, so an
 * account holding only TOTP could not get in at all. Two independent copies of
 * that distinction would eventually disagree, and the direction they'd disagree
 * in is "cheerfully let someone delete their last way in".
 */

import { jest, describe, it, expect } from '@jest/globals';
/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

let user: { password?: string; oauth?: Record<string, { id?: string }> } | null = null;
let passkeys = 0;
let totpActive = false;

const chainable = <T>(value: T) => {
  const q: any = { select: () => q, session: () => q, lean: async () => value };
  return q;
};

const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({}));
const txSession = { id: 'tx' };
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => unknown) => fn(txSession),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: () => chainable(user), updateOne: (...a: unknown[]) => mockUserUpdateOne(...a) },
  WebAuthnCredential: { countDocuments: () => ({ session: () => Promise.resolve(passkeys), then: (r: any) => Promise.resolve(passkeys).then(r) }) },
  UserTotp: { exists: () => ({ session: () => Promise.resolve(totpActive ? { _id: 'x' } : null), then: (r: any) => Promise.resolve(totpActive ? { _id: 'x' } : null).then(r) }) },
}));

const { loadSignInMethods, retainsSignInMethod, removeUnlessLastSignInMethod } = await import('../src/helpers/sign-in-methods.js');

/** Set the account's credentials for one case. */
function account(opts: { password?: boolean; provider?: boolean; passkeys?: number; totp?: boolean }) {
  user = {
    ...(opts.password ? { password: '$2a$12$hash' } : {}),
    oauth: opts.provider ? { google: { id: 'g-1' } } : {},
  };
  passkeys = opts.passkeys ?? 0;
  totpActive = opts.totp ?? false;
}

describe('loadSignInMethods', () => {
  it('reports what the account holds, never the password itself', async () => {
    account({ password: true, provider: true, passkeys: 2, totp: true });
    expect(await loadSignInMethods('u1')).toEqual({
      hasPassword: true, hasProvider: true, passkeyCount: 2, hasTotp: true,
    });
  });

  it('treats an empty password hash and an id-less oauth link as absent', async () => {
    user = { password: '', oauth: { google: {} } };
    passkeys = 0;
    totpActive = false;
    expect(await loadSignInMethods('u1')).toMatchObject({ hasPassword: false, hasProvider: false });
  });

  it('answers cleanly for a user that no longer exists', async () => {
    user = null;
    passkeys = 0;
    totpActive = false;
    expect(await loadSignInMethods('gone')).toEqual({
      hasPassword: false, hasProvider: false, passkeyCount: 0, hasTotp: false,
    });
  });
});

describe('retainsSignInMethod — removing a passkey', () => {
  it.each([
    ['a password remains', { password: true, passkeys: 1 }, true],
    ['a linked provider remains', { provider: true, passkeys: 1 }, true],
    ['another passkey remains', { passkeys: 2 }, true],
    ['it is the only way in', { passkeys: 1 }, false],
  ])('%s', async (_name, opts, expected) => {
    account(opts);
    expect(retainsSignInMethod(await loadSignInMethods('u1'), 'passkey')).toBe(expected);
  });

  it('is NOT rescued by an authenticator app — TOTP cannot sign anyone in alone', async () => {
    account({ passkeys: 1, totp: true });
    expect(retainsSignInMethod(await loadSignInMethods('u1'), 'passkey')).toBe(false);
  });
});

describe('retainsSignInMethod — disabling TOTP', () => {
  it.each([
    ['a password remains', { password: true, totp: true }, true],
    ['a linked provider remains', { provider: true, totp: true }, true],
    ['a passkey remains', { passkeys: 1, totp: true }, true],
    ['nothing else remains', { totp: true }, false],
  ])('%s', async (_name, opts, expected) => {
    account(opts);
    expect(retainsSignInMethod(await loadSignInMethods('u1'), 'totp')).toBe(expected);
  });
});

describe('removeUnlessLastSignInMethod — the guard and the delete are ONE decision', () => {
  it('MATERIALIZES the conflict on the User doc, inside the transaction, before counting', async () => {
    account({ passkeys: 2 });
    const remove = jest.fn(async (..._args: unknown[]) => true);
    await expect(removeUnlessLastSignInMethod('u1', 'passkey', 'LAST', remove)).resolves.toBe(true);
    // Two concurrent removals both write this field, so Mongo aborts one; its
    // retry re-counts and is refused.
    expect(mockUserUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $inc: { credentialsEpoch: 1 } }, { session: txSession });
    expect(remove).toHaveBeenCalledWith(txSession);
  });

  it('refuses — and deletes nothing — when it is the last way in', async () => {
    account({ passkeys: 1 });
    const remove = jest.fn(async (..._args: unknown[]) => true);
    await expect(removeUnlessLastSignInMethod('u1', 'passkey', 'LAST', remove)).rejects.toThrow('LAST');
    expect(remove).not.toHaveBeenCalled();
  });
});
