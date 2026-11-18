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
 *
 * RESERVE BEFORE CHECKING. Counting a failure only AFTER the password compare
 * would let a burst of parallel guesses all read "not locked", all run the
 * compare, and only then be counted — so the bound would be `maxFailures` PLUS
 * the attacker's concurrency, and a right guess inside the burst would sign in.
 * So a sign-in first RESERVES an attempt ({@link reservePasswordAttempt}): one
 * atomic update that adds an in-flight reservation only while the account is not
 * locked and `failedAttempts + live reservations < maxFailures`. Only a request
 * holding a reservation compares the password; then it either turns the
 * reservation into a failure ({@link recordPasswordFailure}, same atomic update
 * as the increment) or, on the right password, drops it and ends the run
 * ({@link completePasswordAttempt}). A reservation left by a crash mid-check
 * stops counting after {@link PASSWORD_ATTEMPT_RESERVATION_MS} on its own.
 */

import { randomUUID } from 'node:crypto';
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

/**
 * How long an in-flight reservation counts. Far longer than a password compare
 * (bcrypt is ~100 ms), short enough that a slot leaked by a crashed request
 * frees itself quickly.
 */
export const PASSWORD_ATTEMPT_RESERVATION_MS = 30_000;

/** A reserved password check — the licence to compare one password for `userId`. */
export interface PasswordAttempt {
  readonly userId: string;
  readonly reservationId: string;
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

/** A lockout filter fragment: the run is not (or no longer) locked. */
function notLocked(now: Date): Record<string, unknown> {
  return { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] };
}

interface ReservationView {
  lockedUntil?: Date | null;
  reservations?: { id: string; exp: Date }[];
}

/** Mongo's duplicate-key error — two first-ever reservations racing the upsert. */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/**
 * Reserve ONE password check for `userId`, atomically, BEFORE the password is
 * compared. Granted only while the account is not locked and
 * `failedAttempts + live reservations < maxFailures`; otherwise throws
 * {@link PasswordLockedOutError} — the caller answers it with the lockout's own
 * 429, so a refused attempt looks exactly like a locked account. Expired
 * reservations (a crashed request's) are pruned in the same update.
 */
export async function reservePasswordAttempt(userId: string): Promise<PasswordAttempt> {
  const { maxFailures } = limits();
  const now = new Date();
  const reservationId = randomUUID();
  const exp = new Date(now.getTime() + PASSWORD_ATTEMPT_RESERVATION_MS);
  const pipeline = [
    {
      $set: {
        failedAttempts: { $ifNull: ['$failedAttempts', 0] },
        lockedUntil: { $ifNull: ['$lockedUntil', null] },
        reservations: { $filter: { input: { $ifNull: ['$reservations', []] }, cond: { $gt: ['$$this.exp', now] } } },
      },
    },
    {
      $set: {
        reservations: {
          $cond: [
            {
              $and: [
                // null sorts below every date, so an unlocked run passes too.
                { $lte: ['$lockedUntil', now] },
                { $lt: [{ $add: ['$failedAttempts', { $size: '$reservations' }] }, maxFailures] },
              ],
            },
            { $concatArrays: ['$reservations', [{ id: reservationId, exp }]] },
            '$reservations',
          ],
        },
        // The record must outlive the reservation; never pull a lock's TTL back.
        expiresAt: { $max: [{ $ifNull: ['$expiresAt', exp] }, exp] },
      },
    },
  ];
  const run = () => PasswordLoginLockout.findOneAndUpdate({ userId }, pipeline, {
    upsert: true,
    returnDocument: 'after',
    updatePipeline: true,
    projection: { lockedUntil: 1, reservations: 1 },
  }).lean<ReservationView>();
  let doc: ReservationView | null;
  try {
    doc = await run();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    doc = await run(); // the racing upsert created the record; this one updates it
  }
  if (doc?.reservations?.some((r) => r.id === reservationId)) return { userId, reservationId };

  const lockedUntil = doc?.lockedUntil ? new Date(doc.lockedUntil) : null;
  if (lockedUntil && lockedUntil.getTime() > now.getTime()) throw new PasswordLockedOutError(lockedUntil);
  // Not locked, but every remaining attempt is in flight: retry once the first frees up.
  const soonest = (doc?.reservations ?? []).reduce<number>((min, r) => Math.min(min, new Date(r.exp).getTime()), exp.getTime());
  throw new PasswordLockedOutError(new Date(soonest));
}

/**
 * Count one failed password for `userId`; locks the account once the run
 * reaches the limit. With a `reservationId` the reservation is turned into the
 * failure in the SAME atomic update.
 */
export async function recordPasswordFailure(userId: string, reservationId?: string): Promise<void> {
  const l = limits();
  await recordFailure(PasswordLoginLockout as unknown as LockoutModel, userId, 'password', l, {
    upsert: true,
    windowMs: l.windowMs,
    auditAction: 'user.login.locked_out',
    ...(reservationId ? { pull: { reservations: { id: reservationId } } } : {}),
  });
}

/**
 * The reserved check found the RIGHT password: drop the reservation and end the
 * run. Throws {@link PasswordLockedOutError} if a lockout is nonetheless live
 * (one that landed while this check ran) — the right password never lifts it.
 *
 * Common path is one round trip: delete the record when it is not locked and no
 * OTHER check is in flight. Otherwise only this reservation is dropped and the
 * failure count reset, so concurrent checks keep their slots.
 */
export async function completePasswordAttempt(attempt: PasswordAttempt): Promise<void> {
  const { userId, reservationId } = attempt;
  const now = new Date();
  const deleted = await PasswordLoginLockout.deleteOne({
    userId,
    ...notLocked(now),
    reservations: { $not: { $elemMatch: { id: { $ne: reservationId }, exp: { $gt: now } } } },
  });
  if (deleted.deletedCount) return;
  await releasePasswordAttempt(attempt);
  await assertPasswordNotLocked(userId);
  await PasswordLoginLockout.updateOne({ userId, ...notLocked(now) }, { $set: { failedAttempts: 0 } });
}

/** Give a reservation back without a verdict (the check itself errored). */
export async function releasePasswordAttempt(attempt: PasswordAttempt): Promise<void> {
  await PasswordLoginLockout.updateOne({ userId: attempt.userId }, { $pull: { reservations: { id: attempt.reservationId } } });
}

/**
 * A correct password ends the run. Only a NOT-locked run is cleared — a live
 * lockout is never lifted by the password it was protecting (the caller checks
 * {@link assertPasswordNotLocked} first; this filter makes a race harmless).
 */
export async function clearPasswordFailures(userId: string): Promise<void> {
  await PasswordLoginLockout.deleteOne({ userId, ...notLocked(new Date()) });
}
