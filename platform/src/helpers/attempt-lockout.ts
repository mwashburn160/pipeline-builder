// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consecutive-failure lockout for per-account code verification (the
 * authenticator app and the recovery-only sign-in leg). A 6-digit code is ~20
 * bits, so the lockout — not the code — is what makes online guessing hopeless.
 * Both legs share the `config.auth.totp` limits so they bound guessing alike.
 */

import { createLogger, errorMessage, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
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
  const lockedUntil = new Date(Date.now() + limits.lockoutMs);
  await model.updateOne(
    { userId },
    { $set: { lockedUntil, failedAttempts: 0 } },
  );
  logger.warn(`${label} locked out after repeated failures`, { userId, lockoutMs: limits.lockoutMs });
  await auditLockout(userId, label, lockedUntil, limits.maxFailures);
}

/**
 * Record the lockout as `user.mfa.locked_out` — the moment a guessing run
 * crossed the limit, filed against the account and its active org so the org's
 * admins see it. System actor: the guesser is unauthenticated by definition.
 * Lazily imported (audit → chain → models) and best-effort: a failed write must
 * never undo, or fail, the lockout itself.
 */
async function auditLockout(userId: string, label: string, lockedUntil: Date, failures: number): Promise<void> {
  try {
    const [{ recordAuditEvent }, { User }] = await Promise.all([import('./audit.js'), import('../models/index.js')]);
    const user = await User.findById(userId).select('lastActiveOrgId').lean<{ lastActiveOrgId?: { toString(): string } | null }>();
    const orgId = user?.lastActiveOrgId?.toString();
    recordAuditEvent({
      action: 'user.mfa.locked_out',
      actorId: SYSTEM_ACTOR_ID,
      ...(orgId ? { orgId, affectedOrgId: orgId } : {}),
      targetType: 'user',
      targetId: userId,
      outcome: 'failure',
      details: { factor: label, failures, lockedUntil: lockedUntil.toISOString() },
    });
  } catch (err) {
    logger.warn('Failed to audit a lockout', { userId, error: errorMessage(err) });
  }
}
