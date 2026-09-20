// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle a password sign-in returns INSTEAD of a session when the account
 * has an authenticator app.
 *
 * `POST /auth/login` verifies the password and then, for an MFA account, stops:
 * it mints a challenge and answers `{ mfaRequired: true, challengeId }`. No
 * token, no refresh cookie, no session slot — the password alone must not
 * produce anything a caller can use. `POST /auth/mfa/verify` trades the handle
 * plus a code (generated or recovery) for the session the login would have
 * opened.
 *
 * WHY A SERVER-SIDE HANDLE rather than a signed "half-token": the handle is 256
 * random bits that name a row in the SHARED Redis pending-state store, so it can
 * be invalidated the instant it is spent and cannot be verified by anything that
 * merely holds the signing key. It also keeps the password-verified state off
 * the client entirely.
 *
 * SINGLE-USE means it yields at most ONE session: the entry is removed the
 * moment tokens are issued. A WRONG code deliberately does NOT burn it — a
 * mistyped digit sending someone back to re-enter their password would push
 * people towards weaker factors, and guessing is already bounded twice over, by
 * the route's rate limiter and by the per-user TOTP lockout.
 */

import crypto from 'crypto';
import { config } from '../config/index.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';

/** What a pending challenge remembers about the sign-in that produced it. */
interface PendingMfaChallenge {
  /** The account whose password was verified. */
  userId: string;
  /** Active org the completed sign-in should land on — resolved BEFORE the
   *  challenge so the second leg can't be steered somewhere else. */
  orgId?: string;
  /** Only a RECOVERY CODE can finish this sign-in: the account has no
   *  authenticator app (its factor is a passkey), and the org's MFA policy
   *  refused the password alone. */
  recoveryOnly?: boolean;
  /** The verified password no longer meets the person's org password policy:
   *  once the second factor verifies, the sign-in owes a forced password change
   *  (to at least this length) instead of a session. */
  passwordChangeMinLength?: number;
  /** Unix seconds; carried so the client can show a countdown. */
  expiresAt: number;
}

const challenges = createPendingStateStore<PendingMfaChallenge>({
  prefix: 'mfa:login:',
  ttlMs: config.auth.totp.challengeTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.auth.totp.maxPendingChallenges,
});

/** Test hook: drop in-memory challenge state between cases. */
export function _resetChallengesForTests(): void {
  challenges._resetForTests();
}

export interface IssuedMfaChallenge {
  challengeId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** Open a challenge for a password sign-in that still owes a second factor.
 *  `recoveryOnly` when the only code the account can present is a recovery code. */
export async function createMfaChallenge(
  userId: string,
  orgId?: string,
  opts: { recoveryOnly?: boolean; passwordChangeMinLength?: number } = {},
): Promise<IssuedMfaChallenge> {
  const challengeId = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Math.floor((Date.now() + config.auth.totp.challengeTtlMs) / 1000);
  await challenges.put(challengeId, {
    userId,
    ...(orgId ? { orgId } : {}),
    ...(opts.recoveryOnly ? { recoveryOnly: true } : {}),
    ...(opts.passwordChangeMinLength ? { passwordChangeMinLength: opts.passwordChangeMinLength } : {}),
    expiresAt,
  });
  return { challengeId, expiresAt };
}

/** Read a challenge WITHOUT spending it — the code is verified first, and only a
 *  correct one gets to {@link consumeMfaChallenge}. */
export async function peekMfaChallenge(challengeId: string): Promise<PendingMfaChallenge | null> {
  return challenges.peek(challengeId);
}

/** Spend the challenge. Called only once the code has verified and the session
 *  is about to be issued, so the handle can never yield a second one. */
export async function consumeMfaChallenge(challengeId: string): Promise<void> {
  await challenges.remove(challengeId);
}
