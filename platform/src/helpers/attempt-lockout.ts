// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consecutive-failure lockout for per-account code verification (the
 * authenticator app and the recovery-only sign-in leg). A 6-digit code is ~20
 * bits, so the lockout — not the code — is what makes online guessing hopeless.
 * Both legs share the `config.auth.totp` limits so they bound guessing alike.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { TOTP_LOCKED_OUT } from '../services/totp-errors.js';

const logger = createLogger('attempt-lockout');

/** A per-user document carrying `failedAttempts` / `lockedUntil`. */
export interface LockoutModel {
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options: Record<string, unknown>): {
    lean(): PromiseLike<{ failedAttempts?: number } | null>;
  };
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): unknown;
}

/** Refuse every verification while a lockout is live. Throws `TOTP_LOCKED_OUT`. */
export function assertNotLocked(doc: { lockedUntil?: Date | null } | null | undefined): void {
  const until = doc?.lockedUntil;
  if (until && new Date(until).getTime() > Date.now()) throw new Error(TOTP_LOCKED_OUT);
}

/**
 * Count a failed attempt and lock the account out once the run reaches
 * `maxFailures`.
 *
 * Counted in ONE atomic update so parallel guesses can't each read "4" and none
 * of them trip the limit. The lockout is set by a second write only when the
 * increment crossed it — the common path is a single round trip.
 */
export async function recordFailure(
  model: LockoutModel,
  userId: string,
  label: string,
  limits: { maxFailures: number; lockoutMs: number },
): Promise<void> {
  const updated = await model.findOneAndUpdate(
    { userId },
    { $inc: { failedAttempts: 1 } },
    { new: true, projection: { failedAttempts: 1 } },
  ).lean();
  if (!updated || (updated.failedAttempts ?? 0) < limits.maxFailures) return;
  await model.updateOne(
    { userId },
    { $set: { lockedUntil: new Date(Date.now() + limits.lockoutMs), failedAttempts: 0 } },
  );
  logger.warn(`${label} locked out after repeated failures`, { userId, lockoutMs: limits.lockoutMs });
}
