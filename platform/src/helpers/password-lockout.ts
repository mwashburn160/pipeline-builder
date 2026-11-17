// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DURABLE per-account password lockout — the Mongo-backed backstop to the
 * per-account Redis limiter (middleware/login-limiter.ts).
 *
 * The Redis bucket is the first line and answers every identifier alike, but it
 * fails OPEN on a store error (`passOnStoreError`) — during a Redis outage it
 * stops counting, and only the per-IP limiter (also Redis) is left. This counter
 * lives in Mongo, which a password sign-in already depends on, so guessing a
 * real account's password stays bounded at `maxFailures` per `lockoutMs`
 * whatever Redis is doing.
 *
 * It reuses helpers/attempt-lockout.ts — the same atomic `$inc`-then-lock the
 * authenticator app and recovery codes use — over its own collection
 * (`PasswordLoginLockout`), whose documents exist only while a run is in
 * progress and age out by TTL.
 *
 * UX: while locked, password sign-in answers the SAME 429 the Redis bucket gives
 * (`RATE_LIMIT_EXCEEDED`, same message, `retryAfterSeconds`) whether or not the
 * password is right, so the two layers are indistinguishable to a caller and a
 * correct guess during a lockout reveals nothing. Only real accounts are
 * counted (an unknown identifier has nothing to lock); with the default limits
 * matching the Redis bucket, the bucket trips first while Redis is healthy, so
 * this adds no "account exists" signal in normal operation.
 */

import { assertNotLocked, recordFailure, type LockoutModel } from './attempt-lockout.js';
import { config } from '../config/index.js';
import { PasswordLoginLockout } from '../models/index.js';
import { TOTP_LOCKED_OUT } from '../services/totp-errors.js';

/** Password sign-in refused: the account's lockout is live. */
export const PASSWORD_LOCKED_OUT = 'PASSWORD_LOCKED_OUT';

/** The 429 message — the per-account Redis bucket's own, on purpose. */
export const PASSWORD_LOCKOUT_MESSAGE =
  'Too many failed sign-in attempts for this account. Please wait a few minutes, or sign in with a passkey.';

/** Thrown while a lockout is live; carries when it ends. */
export class PasswordLockedOutError extends Error {
  constructor(readonly lockedUntil: Date) {
    super(PASSWORD_LOCKED_OUT);
  }

  /** Seconds until the lockout passes (at least 1) — for `Retry-After`. */
  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil((this.lockedUntil.getTime() - Date.now()) / 1000));
  }
}

function limits(): { maxFailures: number; lockoutMs: number; windowMs: number } {
  return config.auth.passwordLockout;
}

/** Throw {@link PasswordLockedOutError} while `userId` is locked out of password sign-in. */
export async function assertPasswordNotLocked(userId: string): Promise<void> {
  const doc = await PasswordLoginLockout.findOne({ userId }).select('lockedUntil').lean();
  try {
    assertNotLocked(doc);
  } catch (err) {
    if (err instanceof Error && err.message === TOTP_LOCKED_OUT && doc?.lockedUntil) {
      throw new PasswordLockedOutError(new Date(doc.lockedUntil));
    }
    throw err;
  }
}

/** Count one failed password for `userId`; locks the account once the run reaches the limit. */
export async function recordPasswordFailure(userId: string): Promise<void> {
  const l = limits();
  await recordFailure(PasswordLoginLockout as unknown as LockoutModel, userId, 'password', l, {
    upsert: true,
    windowMs: l.windowMs,
    auditAction: 'user.login.locked_out',
  });
}

/**
 * A correct password ends the run. Only a NOT-locked run is cleared — a live
 * lockout is never lifted by the password it was protecting (the caller checks
 * {@link assertPasswordNotLocked} first; this filter makes a race harmless).
 */
export async function clearPasswordFailures(userId: string): Promise<void> {
  await PasswordLoginLockout.deleteOne({
    userId,
    $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }],
  });
}
