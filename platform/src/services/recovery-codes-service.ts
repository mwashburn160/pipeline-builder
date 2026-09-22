// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MFA recovery codes — ONE set per account, shared by every second factor.
 *
 * Rules worth stating once:
 *   - A set is minted when the account gets its FIRST second factor, whichever
 *     kind it is (a passkey or an authenticator app), and only then: adding a
 *     second factor keeps the existing sheet, so nobody ends up holding two sets
 *     and wondering which one still works.
 *   - Codes are single-use and stored hashed (`utils/totp.ts#hashRecoveryCode`).
 *     A spend is ONE conditional update on the matching unspent element, so two
 *     concurrent uses of one code race and exactly one wins.
 *   - Regeneration replaces the whole set, and needs a factor to back up.
 *   - When the account's last factor goes, the set goes with it — a recovery
 *     code with nothing to recover is a second password in disguise.
 *   - Guessing is bounded. With an authenticator app, recovery-code failures
 *     are counted on the TOTP enrolment (`totp-service.ts`), so the two share
 *     one budget. Without one (a passkey-only account), the recovery-only
 *     sign-in counts them here, under the same limits.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { RECOVERY_CODES_NO_FACTOR, TOTP_INVALID_CODE } from './totp-errors.js';
import { config } from '../config/index.js';
import { assertNotLocked, recordFailure as recordAttemptFailure } from '../helpers/attempt-lockout.js';
import { hasAnyMfaFactor } from '../helpers/auth-factors.js';
import { MfaRecoveryCodes } from '../models/index.js';
import { RECOVERY_CODE_COUNT, generateRecoveryCode, hashRecoveryCode } from '../utils/totp.js';

const logger = createLogger('recovery-codes');


/** What the settings page shows (never a code). */
export interface RecoveryCodeStatus {
  remaining: number;
  total: number;
  generatedAt: Date | null;
}

function mint(): { codes: string[]; entries: Array<{ hash: string; usedAt: null }> } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  return { codes, entries: codes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null })) };
}

/** The status view. No set reads as zero of zero. */
export async function getRecoveryCodeStatus(userId: string): Promise<RecoveryCodeStatus> {
  const doc = await MfaRecoveryCodes.findOne({ userId }).select('+codes').lean();
  const codes = doc?.codes ?? [];
  return {
    remaining: codes.filter((c) => !c.usedAt).length,
    total: codes.length,
    generatedAt: doc?.generatedAt ?? null,
  };
}

/** Whether the account has at least one unspent code — what decides whether a
 *  recovery-code sign-in can be offered at all. */
export async function hasUnspentRecoveryCodes(userId: string): Promise<boolean> {
  return !!(await MfaRecoveryCodes.exists({ userId, codes: { $elemMatch: { usedAt: null } } }));
}

/**
 * Mint the account's set IF IT HAS NONE — called when a factor is enrolled.
 * Returns the codes (shown once) when a set was created, or `null` when the
 * account already had one (the existing sheet stays valid).
 *
 * The insert is conditional (`$setOnInsert` on an upsert keyed by `userId`), so
 * two first-factor enrolments racing each other mint exactly one set.
 */
export async function issueRecoveryCodesIfAbsent(userId: string): Promise<string[] | null> {
  const { codes, entries } = mint();
  const result = await MfaRecoveryCodes.updateOne(
    { userId },
    { $setOnInsert: { userId, codes: entries, generatedAt: new Date(), failedAttempts: 0, lockedUntil: null } },
    { upsert: true },
  );
  if (!result.upsertedCount) return null;
  logger.info('Recovery codes minted with the first second factor', { userId });
  return codes;
}

/**
 * Replace the set (every old code, spent or not, stops working). Refused when
 * the account has no second factor to back up.
 */
export async function regenerateRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }> {
  if (!(await hasAnyMfaFactor(userId))) throw new Error(RECOVERY_CODES_NO_FACTOR);
  const { codes, entries } = mint();
  await MfaRecoveryCodes.updateOne(
    { userId },
    { $set: { codes: entries, generatedAt: new Date(), failedAttempts: 0, lockedUntil: null } },
    { upsert: true },
  );
  return { recoveryCodes: codes };
}

/**
 * Spend one unused code, returning how many remain — or `null` when the value
 * matches nothing unspent. Does NOT count failures: the caller owns the budget
 * (see the module doc).
 */
export async function spendRecoveryCode(userId: string, code: string): Promise<number | null> {
  const hash = hashRecoveryCode(code);
  const updated = await MfaRecoveryCodes.findOneAndUpdate(
    { userId, codes: { $elemMatch: { hash, usedAt: null } } },
    { $set: { 'codes.$.usedAt': new Date() } },
    { new: true, projection: { codes: 1 } },
  ).select('+codes').lean();
  if (!updated) return null;
  return (updated.codes ?? []).filter((c) => !c.usedAt).length;
}

/**
 * Verify a recovery code for an account WITHOUT an authenticator app (the
 * recovery-only sign-in leg), under this set's own lockout. Returns how many
 * codes remain. Throws `TOTP_LOCKED_OUT` / `TOTP_INVALID_CODE`, the same
 * sentinels the authenticator path uses, so the sign-in answers identically.
 */
export async function verifyRecoveryCode(userId: string, code: string): Promise<number> {
  const doc = await MfaRecoveryCodes.findOne({ userId }).select('lockedUntil').lean();
  if (!doc) throw new Error(TOTP_INVALID_CODE);
  assertNotLocked(doc);

  const remaining = await spendRecoveryCode(userId, code);
  if (remaining !== null) {
    await MfaRecoveryCodes.updateOne({ userId }, { $set: { failedAttempts: 0, lockedUntil: null } });
    return remaining;
  }
  await recordFailure(userId);
  throw new Error(TOTP_INVALID_CODE);
}

/** Count a failed recovery-only attempt (the authenticator app's limits, so
 *  both legs bound guessing alike). */
function recordFailure(userId: string): Promise<void> {
  return recordAttemptFailure(MfaRecoveryCodes, userId, 'Recovery-code sign-in', config.auth.totp);
}

/** Delete the set. Returns whether one existed. */
export async function removeRecoveryCodes(userId: string): Promise<boolean> {
  const result = await MfaRecoveryCodes.deleteOne({ userId });
  return (result.deletedCount ?? 0) > 0;
}

/** Drop the set once the account has no second factor left (called after a
 *  factor is removed). Returns whether it was dropped. */
export async function removeRecoveryCodesIfNoFactor(userId: string): Promise<boolean> {
  if (await hasAnyMfaFactor(userId)) return false;
  return removeRecoveryCodes(userId);
}
