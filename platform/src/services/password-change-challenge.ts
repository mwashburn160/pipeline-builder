// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle a password sign-in returns INSTEAD of a session when the password
 * no longer meets the person's org password policy.
 *
 * An org can raise its minimum length at any time, but only bcrypt hashes are
 * stored — an existing password can't be measured until the person types it.
 * So the check runs at PASSWORD SIGN-IN (and only there — a passkey, social or
 * SSO sign-in never sees the password), and a short password opens nothing:
 * `POST /auth/login` (or `/auth/mfa/verify`, after the second factor) answers
 * `{ passwordChangeRequired: true, challengeId, minLength }`, and
 * `POST /auth/password/change-required` trades the handle plus a NEW password
 * that meets the policy for the session the sign-in would have opened.
 *
 * Same shape and guarantees as the MFA sign-in challenge (`mfa-challenge.ts`):
 * 256 random bits naming a row in the SHARED pending-state store, bound to the
 * account and to the auth context the sign-in earned (so completing it can't
 * raise the assurance level), spent exactly once when the session is issued. A
 * REFUSED new password does not burn it — the person just picks another.
 */

import crypto from 'crypto';
import type { AssuranceLevel, AuthMethod } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';

/** Long enough to think of a new password; short enough that a captured handle is worthless. */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** What a pending forced change remembers about the sign-in that produced it. */
export interface PendingPasswordChange {
  userId: string;
  /** The org the completed sign-in lands on — fixed now, like the MFA challenge. */
  orgId?: string;
  /** The auth context the sign-in earned (`['pwd']` / `['pwd','mfa']`). */
  amr: AuthMethod[];
  aal: AssuranceLevel;
  /** The minimum the new password must meet (shown to the person). */
  minLength: number;
  /** Unix seconds. */
  expiresAt: number;
}

const challenges = createPendingStateStore<PendingPasswordChange>({
  prefix: 'pwd:change:',
  ttlMs: CHALLENGE_TTL_MS,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.auth.totp.maxPendingChallenges,
});

/** Test hook: drop in-memory challenge state between cases. */
export function _resetPasswordChangeChallengesForTests(): void {
  challenges._resetForTests();
}

export interface IssuedPasswordChangeChallenge {
  challengeId: string;
  expiresAt: number;
  minLength: number;
}

/** Open a forced-change challenge for a verified password sign-in. */
export async function createPasswordChangeChallenge(
  input: Omit<PendingPasswordChange, 'expiresAt'>,
): Promise<IssuedPasswordChangeChallenge> {
  const challengeId = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Math.floor((Date.now() + CHALLENGE_TTL_MS) / 1000);
  await challenges.put(challengeId, { ...input, expiresAt });
  return { challengeId, expiresAt, minLength: input.minLength };
}

/**
 * CLAIM the challenge — atomically (GETDEL): of two concurrent completions of
 * one handle, exactly one holds it. The claimant validates the new password and
 * either spends it (by doing nothing more) or hands it back with
 * {@link restorePasswordChangeChallenge} on a refusal, so a rejected password
 * still leaves the person their handle.
 */
export async function claimPasswordChangeChallenge(challengeId: string): Promise<PendingPasswordChange | null> {
  return challenges.consume(challengeId);
}

/** Give a claimed challenge back after a refusal, with only its REMAINING life. */
export async function restorePasswordChangeChallenge(challengeId: string, pending: PendingPasswordChange): Promise<void> {
  const remainingMs = pending.expiresAt * 1000 - Date.now();
  if (remainingMs > 0) await challenges.put(challengeId, pending, remainingMs);
}
