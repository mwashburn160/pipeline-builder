// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticator-app codes (TOTP) — enrolment, verification, recovery codes.
 *
 * The algorithm itself is `utils/totp.ts` (pure, RFC-vector-tested). This module
 * owns everything stateful around it, and the rules worth stating once:
 *
 *   - THE SECRET IS ENCRYPTED AT REST. It is written through
 *     `wrapEncrypted(secret, 'user:<userId>')`, so the AES-256-GCM key is
 *     HKDF-derived for that user alone: a row lifted into another account's
 *     record fails its auth tag, and a database dump without
 *     `SECRET_ENCRYPTION_KEY` yields nothing. Clear text exists exactly twice —
 *     while minting the enrolment (to show the person once) and inside
 *     {@link verifyCode}.
 *   - ONE CODE, ONE TIME STEP, ONCE. Every acceptance records the step it
 *     consumed, and the next verification only accepts a STRICTLY GREATER one —
 *     enforced by a conditional update, so two concurrent uses of one code race
 *     and exactly one wins. That is what stops a phishing proxy replaying the
 *     code it just relayed.
 *   - DRIFT IS ±1 STEP. See `TOTP_DRIFT_STEPS`.
 *   - FAILURES LOCK OUT. A 6-digit code is ~20 bits, so the lockout is the real
 *     bound on online guessing; it applies to sign-in and step-up alike, and to
 *     recovery codes, because they share the counter.
 *   - RECOVERY CODES belong to the ACCOUNT, not to this factor
 *     (`recovery-codes-service.ts`): one set, minted with whichever second
 *     factor came first. They are accepted anywhere a generated code is, and a
 *     failed one counts against THIS enrolment's lockout, so the two can't be
 *     guessed on separate budgets.
 *   - ENROLMENT IS REFUSED FOR SSO-ENFORCED ACCOUNTS. When an org owns the
 *     domain and forces SSO, the IdP owns the factors; a second, unmanaged MFA
 *     its admins can neither see nor revoke is worse than none.
 *
 * Throws the string sentinels in `totp-errors.ts`; `controllers/totp.ts` maps
 * them to HTTP.
 */

import { createLogger } from '@pipeline-builder/api-core';
import {
  getRecoveryCodeStatus,
  issueRecoveryCodesIfAbsent,
  removeRecoveryCodesIfNoFactor,
  spendRecoveryCode,
} from './recovery-codes-service.js';
import {
  TOTP_ALREADY_ENROLLED,
  TOTP_INVALID_CODE,
  TOTP_LAST_SIGN_IN_METHOD,
  TOTP_LOCKED_OUT,
  TOTP_NOT_ENROLLED,
  TOTP_SSO_ENFORCED,
} from './totp-errors.js';
import { config } from '../config/index.js';
import { loadSignInMethods, retainsSignInMethod } from '../helpers/sign-in-methods.js';
import { findSsoEnforcementForEmail } from '../helpers/sso-enforcement.js';
import { User, UserTotp } from '../models/index.js';
import { unwrapEncrypted, wrapEncrypted } from '../utils/secret-blob.js';
import { generateTotpSecret, totpAuthUri, verifyTotp } from '../utils/totp.js';

const logger = createLogger('totp');

/** The encryption salt a user's secret is bound to. Not an org id: a TOTP secret
 *  belongs to the person, and binding it to whichever org they happened to be
 *  scoped to would make it unreadable the moment they left that org. */
function secretContext(userId: string): string {
  return `user:${userId}`;
}

/** What {@link beginEnrolment} hands back — the ONLY time the secret is
 *  readable, which is why the caller shows it and never stores it. */
export interface TotpEnrolment {
  /** Base32 secret, for the "can't scan it?" manual-entry field. */
  secret: string;
  /** `otpauth://totp/…` — the QR payload the authenticator scans. */
  otpauthUri: string;
}

/** The account's TOTP state as the settings page reads it (never the secret). */
export interface TotpStatus {
  /** A confirmed enrolment exists — this account is MFA-protected. */
  enabled: boolean;
  /** An enrolment was started but never confirmed with a code. */
  pending: boolean;
  activatedAt: Date | null;
  lastUsedAt: Date | null;
  /** Unspent recovery codes (the ACCOUNT's set, shared with passkeys). Zero on
   *  an active enrolment is worth surfacing — a lost phone then means an admin
   *  reset, not a self-service one. */
  recoveryCodesRemaining: number;
  recoveryCodesTotal: number;
  recoveryGeneratedAt: Date | null;
  /** Set while the account is locked out after repeated failures. */
  lockedUntil: Date | null;
}

/** How a code was honoured — carried into `amr`, audit and metrics. */
export type TotpVerifyMethod = 'totp' | 'recovery';

export interface TotpVerification {
  method: TotpVerifyMethod;
  /** Unspent recovery codes AFTER this verification, so a sign-in that burned
   *  one can warn the person how few are left. */
  recoveryCodesRemaining: number;
}

/** Whether the account has a CONFIRMED enrolment (what `authFactors.hasTotp`
 *  reports, and what the sign-in path branches on). */
export async function hasActiveTotp(userId: string): Promise<boolean> {
  return !!(await UserTotp.exists({ userId, activatedAt: { $ne: null } }));
}

/** The settings-page view. Absent enrolment reads as a clean "off". */
export async function getStatus(userId: string): Promise<TotpStatus> {
  const doc = await UserTotp.findOne({ userId }).lean() as
    {
      activatedAt?: Date | null;
      lastUsedAt?: Date | null;
      lockedUntil?: Date | null;
    } | null;
  if (!doc) {
    return {
      enabled: false,
      pending: false,
      activatedAt: null,
      lastUsedAt: null,
      recoveryCodesRemaining: 0,
      recoveryCodesTotal: 0,
      recoveryGeneratedAt: null,
      lockedUntil: null,
    };
  }
  const recovery = await getRecoveryCodeStatus(userId);
  const locked = doc.lockedUntil && doc.lockedUntil.getTime() > Date.now() ? doc.lockedUntil : null;
  return {
    enabled: !!doc.activatedAt,
    pending: !doc.activatedAt,
    activatedAt: doc.activatedAt ?? null,
    lastUsedAt: doc.lastUsedAt ?? null,
    recoveryCodesRemaining: recovery.remaining,
    recoveryCodesTotal: recovery.total,
    recoveryGeneratedAt: recovery.generatedAt,
    lockedUntil: locked,
  };
}

/**
 * Start an enrolment: mint a secret, store it encrypted as PENDING, and return
 * what the person needs to scan it.
 *
 * Re-entrant by design — an enrolment abandoned halfway (a closed tab, a phone
 * that wouldn't scan) is simply replaced, with a NEW secret. Replacing rather
 * than reusing matters: the old secret was displayed, so it must never be the
 * one that ends up confirmed.
 *
 * Refused outright once an enrolment is ACTIVE: silently rotating the secret
 * under a working authenticator is how people lock themselves out. Disable
 * first (which takes a step-up).
 */
export async function beginEnrolment(userId: string): Promise<TotpEnrolment> {
  const user = await User.findById(userId).select('email').lean() as { email: string } | null;
  if (!user) throw new Error(TOTP_NOT_ENROLLED);

  // The org's IdP owns the factors for an SSO-governed address.
  if (await findSsoEnforcementForEmail(user.email)) throw new Error(TOTP_SSO_ENFORCED);
  if (await hasActiveTotp(userId)) throw new Error(TOTP_ALREADY_ENROLLED);

  const secret = generateTotpSecret();
  const encrypted = await wrapEncrypted(secret, secretContext(userId));
  // Upsert, resetting every piece of per-enrolment state: a stale `lastUsedStep`
  // from a previous enrolment would silently reject the new secret's first codes,
  // and a stale lockout would block confirming it.
  await UserTotp.findOneAndUpdate(
    { userId },
    {
      $set: {
        secret: encrypted,
        activatedAt: null,
        lastUsedStep: 0,
        failedAttempts: 0,
        lockedUntil: null,
        lastUsedAt: null,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true },
  );

  return {
    secret,
    otpauthUri: totpAuthUri({ secret, account: user.email, issuer: config.auth.totp.issuer }),
  };
}

/**
 * Confirm a pending enrolment with a code from the authenticator — and, when
 * this is the account's FIRST second factor, mint its recovery codes (returned
 * once). An account that already has a set (from a passkey) keeps it, and gets
 * `recoveryCodes: []`.
 *
 * Confirming with a real code (rather than trusting the scan) is the whole point
 * of the two-step enrolment: it proves the secret actually reached a working
 * authenticator before the account starts depending on it to sign in.
 */
export async function activate(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const doc = await UserTotp.findOne({ userId }).select('+secret').lean() as
    {
      _id: unknown;
      secret: string;
      activatedAt?: Date | null;
      lastUsedStep: number;
      lockedUntil?: Date | null;
      failedAttempts: number;
    } | null;
  if (!doc) throw new Error(TOTP_NOT_ENROLLED);
  if (doc.activatedAt) throw new Error(TOTP_ALREADY_ENROLLED);
  assertNotLockedOut(doc.lockedUntil);

  const secret = await unwrapEncrypted(doc.secret, secretContext(userId), 'totp.secret');
  const step = verifyTotp(secret, code, { minStep: doc.lastUsedStep });
  if (step === null) {
    await recordFailure(userId);
    throw new Error(TOTP_INVALID_CODE);
  }

  await UserTotp.updateOne(
    { userId },
    {
      $set: {
        activatedAt: new Date(),
        lastUsedStep: step,
        lastUsedAt: new Date(),
        failedAttempts: 0,
        lockedUntil: null,
      },
    },
  );
  const recoveryCodes = await issueRecoveryCodesIfAbsent(userId);
  logger.info('TOTP enrolment activated', { userId, recoveryCodesMinted: !!recoveryCodes });
  return { recoveryCodes: recoveryCodes ?? [] };
}

/**
 * Verify a code (generated or recovery) for an ACTIVE enrolment.
 *
 * Shared verbatim by the sign-in MFA exchange and the TOTP step-up, so neither
 * can drift from the other's replay, drift or lockout rules.
 */
export async function verifyCode(userId: string, code: string): Promise<TotpVerification> {
  const doc = await UserTotp.findOne({ userId, activatedAt: { $ne: null } })
    .select('+secret').lean() as
    {
      secret: string;
      lastUsedStep: number;
      lockedUntil?: Date | null;
    } | null;
  if (!doc) throw new Error(TOTP_NOT_ENROLLED);
  assertNotLockedOut(doc.lockedUntil);

  const secret = await unwrapEncrypted(doc.secret, secretContext(userId), 'totp.secret');
  const step = verifyTotp(secret, code, { minStep: doc.lastUsedStep });
  if (step !== null) {
    // CONDITIONAL on the step we read: of two concurrent uses of the same code,
    // only the first update matches, and the loser is treated as a replay.
    const claimed = await UserTotp.findOneAndUpdate(
      { userId, lastUsedStep: doc.lastUsedStep },
      { $set: { lastUsedStep: step, lastUsedAt: new Date(), failedAttempts: 0, lockedUntil: null } },
      { projection: { _id: 1 } },
    ).lean();
    if (!claimed) {
      await recordFailure(userId);
      throw new Error(TOTP_INVALID_CODE);
    }
    return {
      method: 'totp',
      recoveryCodesRemaining: (await getRecoveryCodeStatus(userId)).remaining,
    };
  }

  const recovery = await spendRecoveryCode(userId, code);
  if (recovery !== null) {
    // A good recovery code ends a failure run exactly like a good generated one.
    await UserTotp.updateOne({ userId }, { $set: { lastUsedAt: new Date(), failedAttempts: 0, lockedUntil: null } });
    return { method: 'recovery', recoveryCodesRemaining: recovery };
  }

  await recordFailure(userId);
  throw new Error(TOTP_INVALID_CODE);
}

/**
 * Turn TOTP off, taking the secret with it — and the account's recovery codes
 * too when no passkey remains (a recovery code with no factor to recover is a
 * second password in disguise).
 *
 * Refused when nothing else could open a session (see
 * `helpers/sign-in-methods.ts`) — the same rule that stops the last passkey from
 * being removed, asked through the same helper so the two can't disagree.
 */
export async function disable(userId: string): Promise<void> {
  const existing = await UserTotp.exists({ userId, activatedAt: { $ne: null } });
  if (!existing) throw new Error(TOTP_NOT_ENROLLED);
  if (!retainsSignInMethod(await loadSignInMethods(userId), 'totp')) {
    throw new Error(TOTP_LAST_SIGN_IN_METHOD);
  }
  await UserTotp.deleteOne({ userId });
  const codesRemoved = await removeRecoveryCodesIfNoFactor(userId);
  logger.info('TOTP disabled', { userId, recoveryCodesRemoved: codesRemoved });
}

/** Refuse every verification while a lockout is live. */
function assertNotLockedOut(lockedUntil: Date | null | undefined): void {
  if (lockedUntil && lockedUntil.getTime() > Date.now()) throw new Error(TOTP_LOCKED_OUT);
}

/**
 * Count a failed code and lock the account's TOTP out once the run reaches the
 * threshold.
 *
 * Counted in ONE atomic update so parallel guesses can't each read "4" and none
 * of them trip the limit. The lockout is computed by a second write only when
 * the increment crossed it — the common path is a single round trip.
 */
async function recordFailure(userId: string): Promise<void> {
  const { maxFailures, lockoutMs } = config.auth.totp;
  const updated = await UserTotp.findOneAndUpdate(
    { userId },
    { $inc: { failedAttempts: 1 } },
    { new: true, projection: { failedAttempts: 1 } },
  ).lean() as { failedAttempts?: number } | null;
  if (!updated || (updated.failedAttempts ?? 0) < maxFailures) return;
  await UserTotp.updateOne(
    { userId },
    { $set: { lockedUntil: new Date(Date.now() + lockoutMs), failedAttempts: 0 } },
  );
  logger.warn('TOTP locked out after repeated failures', { userId, lockoutMs });
}
