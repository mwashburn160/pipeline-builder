// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Forgot-password: the self-service way back in for a person whose only
 * sign-in method is a password they no longer remember.
 *
 *   1. `requestPasswordReset(email)` — mint a single-use token, store only its
 *      SHA-256 (`password_reset_tokens`, TTL-indexed), and hand the RAW token to
 *      the caller to email. Answers the same way whether or not the address
 *      names an account (the controller always returns 200), so it can never be
 *      used to enumerate accounts.
 *   2. `resetPassword(token, newPassword)` — claim the token atomically
 *      (single use), set the password, and end EVERYTHING that speaks for the
 *      account: `tokenVersion` bump, every refresh slot, every access key. A
 *      reset is what someone does when their password is gone, which includes
 *      "someone else changed it".
 *
 * Who never gets a link (silently — the response is the same):
 *   - no account with that email;
 *   - an account with no password (social / SSO only) — a reset would ADD a
 *     sign-in method the person never chose, on the strength of a mailbox;
 *   - an identity governed by an org's "SSO required" policy (owners keep their
 *     break-glass exemption, exactly as at sign-in).
 * The reset itself re-checks the SSO policy, because it may have switched on
 * between the request and the click.
 *
 * Signing in afterwards still asks for the account's second factor: a reset
 * replaces the password, never the MFA.
 */

import crypto from 'crypto';
import { createLogger } from '@pipeline-builder/api-core';
import { apiKeyService } from './api-key-service.js';
import { deleteAllSlots } from './session/session-store.js';
import { config } from '../config/index.js';
import { assertNewPasswordAcceptable } from '../helpers/password-policy.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { findSsoEnforcementForEmail } from '../helpers/sso-enforcement.js';
import { PasswordLoginLockout, PasswordResetToken, User } from '../models/index.js';

const logger = createLogger('password-reset-service');

/** The reset link is invalid, expired, or already used. */
export const PASSWORD_RESET_TOKEN_INVALID = 'PASSWORD_RESET_TOKEN_INVALID';
/** The account is governed by an org's "SSO required" policy. */
export const PASSWORD_RESET_SSO_REQUIRED = 'PASSWORD_RESET_SSO_REQUIRED';
/** The new password is the one already set. */
export const PASSWORD_RESET_UNCHANGED = 'PASSWORD_RESET_UNCHANGED';

/** Why a request did NOT dispatch — for the audit row and logs, never the response. */
export type ResetRequestSkip = 'unknown-email' | 'no-password' | 'sso-required';

export type ResetRequestOutcome =
  | { dispatched: true; userId: string; email: string; orgId?: string; rawToken: string; ttlMinutes: number }
  | { dispatched: false; reason: ResetRequestSkip; userId?: string; orgId?: string };

export interface ResetOutcome {
  userId: string;
  email: string;
  orgId?: string;
  accessKeysRevoked: number;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Mint a reset token for `email`, or say why not (see the module comment). */
export async function requestPasswordReset(email: string): Promise<ResetRequestOutcome> {
  const normalized = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalized }).select('+password email lastActiveOrgId');
  if (!user) return { dispatched: false, reason: 'unknown-email' };
  const userId = user._id.toString();
  const orgId = user.lastActiveOrgId ? String(user.lastActiveOrgId) : undefined;
  const base = { userId, ...(orgId ? { orgId } : {}) };
  if (!user.password) return { dispatched: false, reason: 'no-password', ...base };
  if (await findSsoEnforcementForEmail(user.email)) return { dispatched: false, reason: 'sso-required', ...base };

  const rawToken = crypto.randomBytes(32).toString('hex');
  // One live link per account: a new request supersedes every earlier one.
  await PasswordResetToken.deleteMany({ userId: user._id });
  await PasswordResetToken.create({
    userId: user._id,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + config.auth.passwordResetTokenTtlMs),
  });
  return {
    dispatched: true,
    ...base,
    email: user.email,
    rawToken,
    ttlMinutes: Math.max(1, Math.round(config.auth.passwordResetTokenTtlMs / 60_000)),
  };
}

/**
 * Set a new password with a reset token. Throws PASSWORD_RESET_TOKEN_INVALID,
 * PASSWORD_RESET_SSO_REQUIRED, PASSWORD_RESET_UNCHANGED, or a
 * `PasswordPolicyServiceError` (400 with its own code).
 *
 * The token is validated and the password checked BEFORE the token is claimed,
 * so a refused password leaves the link usable for a second attempt; the claim
 * itself is an atomic `findOneAndDelete`, so exactly one submission wins.
 */
export async function resetPassword(rawToken: string, newPassword: string): Promise<ResetOutcome> {
  const tokenHash = hashToken(rawToken);
  const live = { tokenHash, expiresAt: { $gt: new Date() } };
  const token = await PasswordResetToken.findOne(live).lean();
  if (!token) throw new Error(PASSWORD_RESET_TOKEN_INVALID);

  const user = await User.findById(token.userId).select('+password +tokenVersion email lastActiveOrgId');
  if (!user || !user.password) {
    await PasswordResetToken.deleteMany({ userId: token.userId });
    throw new Error(PASSWORD_RESET_TOKEN_INVALID);
  }
  if (await findSsoEnforcementForEmail(user.email)) throw new Error(PASSWORD_RESET_SSO_REQUIRED);
  if (await user.comparePassword(newPassword)) throw new Error(PASSWORD_RESET_UNCHANGED);
  await assertNewPasswordAcceptable(newPassword, { userId: user._id.toString() });

  // Single use: only the submission that deletes the row proceeds.
  if (!await PasswordResetToken.findOneAndDelete(live)) throw new Error(PASSWORD_RESET_TOKEN_INVALID);

  user.password = newPassword;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await deleteAllSlots(user._id);
  const userId = user._id.toString();
  await PasswordResetToken.deleteMany({ userId: user._id });
  // The password a failed-password lockout protected no longer exists, and the
  // person just proved control of the account's email — lift it, so they can
  // sign in with the new password straight away.
  await PasswordLoginLockout.deleteOne({ userId: user._id });
  await publishUserRevocation(userId);
  const accessKeysRevoked = await apiKeyService.revokeAllForUser(userId);
  logger.info('Password reset', { userId, accessKeysRevoked });
  return {
    userId,
    email: user.email,
    ...(user.lastActiveOrgId ? { orgId: String(user.lastActiveOrgId) } : {}),
    accessKeysRevoked,
  };
}
