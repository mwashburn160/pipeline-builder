// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `recovery-codes-service` — ONE set of recovery codes per account, whichever
 * second factor came first, against an in-memory stand-in for the collection.
 *
 * Pinned: a set is minted only when the account has none (so a passkey and an
 * authenticator app share one sheet); codes are single-use and stored hashed;
 * regeneration needs a factor to back up; the set leaves with the last factor;
 * and the RECOVERY-ONLY sign-in leg bounds guessing with its own lockout.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createFakeRecoveryCodes } from './helpers/fake-recovery-codes.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.TOTP_MAX_FAILURES = '3';
process.env.TOTP_LOCKOUT_MS = '60000';

const recovery = createFakeRecoveryCodes();
let passkeys = 0;
let totpActive = false;

jest.unstable_mockModule('../src/models/index.js', () => ({
  MfaRecoveryCodes: recovery.model,
  // Linking stub: helpers/auth-factors imports the User model.
  User: {},
  WebAuthnCredential: { countDocuments: async () => passkeys, exists: async () => (passkeys > 0 ? { _id: 'p' } : null) },
  UserTotp: { exists: async () => (totpActive ? { _id: 't' } : null) },
}));

const svc = await import('../src/services/recovery-codes-service.js');
const { TOTP_INVALID_CODE, TOTP_LOCKED_OUT } = await import('../src/services/totp-errors.js');
const { hashRecoveryCode } = await import('../src/utils/totp.js');

const USER = '651111111111111111111111';

beforeEach(() => {
  recovery.reset();
  passkeys = 0;
  totpActive = false;
});

describe('minting', () => {
  it('mints ten hashed codes the first time, and nothing the second', async () => {
    const first = await svc.issueRecoveryCodesIfAbsent(USER);
    expect(first).toHaveLength(10);
    expect(recovery.of(USER)!.codes.map((c) => c.hash)).toEqual(first!.map(hashRecoveryCode));
    expect(JSON.stringify(recovery.of(USER))).not.toContain(first![0]);

    // A second factor keeps the same sheet.
    expect(await svc.issueRecoveryCodesIfAbsent(USER)).toBeNull();
    expect(recovery.of(USER)!.codes.map((c) => c.hash)).toEqual(first!.map(hashRecoveryCode));
  });

  it('reports remaining / total in the status view, zero of zero with no set', async () => {
    expect(await svc.getRecoveryCodeStatus(USER)).toEqual({ remaining: 0, total: 0, generatedAt: null });
    const codes = await svc.issueRecoveryCodesIfAbsent(USER);
    await svc.spendRecoveryCode(USER, codes![0]);
    expect(await svc.getRecoveryCodeStatus(USER)).toMatchObject({ remaining: 9, total: 10 });
  });
});

describe('spending', () => {
  it('each code works once, however it is typed', async () => {
    const codes = (await svc.issueRecoveryCodesIfAbsent(USER))!;
    expect(await svc.spendRecoveryCode(USER, codes[0].toLowerCase())).toBe(9);
    expect(await svc.spendRecoveryCode(USER, codes[0])).toBeNull();
    expect(await svc.spendRecoveryCode(USER, codes[1].replace('-', ' '))).toBe(8);
  });

  it('knows whether any code is left to offer', async () => {
    expect(await svc.hasUnspentRecoveryCodes(USER)).toBe(false);
    await svc.issueRecoveryCodesIfAbsent(USER);
    expect(await svc.hasUnspentRecoveryCodes(USER)).toBe(true);
  });
});

describe('regeneration', () => {
  it('needs a second factor to back up', async () => {
    await expect(svc.regenerateRecoveryCodes(USER)).rejects.toThrow('RECOVERY_CODES_NO_FACTOR');
  });

  it('replaces every old code for a passkey-only account', async () => {
    passkeys = 1;
    const old = (await svc.issueRecoveryCodesIfAbsent(USER))!;
    const { recoveryCodes: fresh } = await svc.regenerateRecoveryCodes(USER);
    expect(fresh).toHaveLength(10);
    expect(await svc.spendRecoveryCode(USER, old[1])).toBeNull();
    expect(await svc.spendRecoveryCode(USER, fresh[0])).toBe(9);
  });
});

describe('the recovery-only sign-in leg', () => {
  it('accepts a code and says how many are left', async () => {
    const codes = (await svc.issueRecoveryCodesIfAbsent(USER))!;
    expect(await svc.verifyRecoveryCode(USER, codes[3])).toBe(9);
  });

  it('refuses an account with no set as an ordinary wrong code', async () => {
    await expect(svc.verifyRecoveryCode(USER, 'AAAAA-AAAAA')).rejects.toThrow(TOTP_INVALID_CODE);
  });

  it('locks out after the configured run of failures, even for a correct code', async () => {
    const codes = (await svc.issueRecoveryCodesIfAbsent(USER))!;
    for (let i = 0; i < 3; i++) {
      await expect(svc.verifyRecoveryCode(USER, 'AAAAA-AAAAA')).rejects.toThrow(TOTP_INVALID_CODE);
    }
    expect(recovery.of(USER)!.lockedUntil).toBeInstanceOf(Date);
    await expect(svc.verifyRecoveryCode(USER, codes[0])).rejects.toThrow(TOTP_LOCKED_OUT);
  });

  it('a success resets the failure run', async () => {
    const codes = (await svc.issueRecoveryCodesIfAbsent(USER))!;
    await expect(svc.verifyRecoveryCode(USER, 'AAAAA-AAAAA')).rejects.toThrow(TOTP_INVALID_CODE);
    await svc.verifyRecoveryCode(USER, codes[0]);
    expect(recovery.of(USER)!.failedAttempts).toBe(0);
  });
});

describe('leaving with the last factor', () => {
  it('stays while a passkey or an authenticator app remains', async () => {
    await svc.issueRecoveryCodesIfAbsent(USER);
    passkeys = 1;
    expect(await svc.removeRecoveryCodesIfNoFactor(USER)).toBe(false);
    passkeys = 0;
    totpActive = true;
    expect(await svc.removeRecoveryCodesIfNoFactor(USER)).toBe(false);
    expect(recovery.of(USER)).toBeDefined();
  });

  it('goes when nothing is left to recover', async () => {
    await svc.issueRecoveryCodesIfAbsent(USER);
    expect(await svc.removeRecoveryCodesIfNoFactor(USER)).toBe(true);
    expect(recovery.of(USER)).toBeUndefined();
  });
});
