// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Types, type HydratedDocument } from 'mongoose';

/**
 * One account's run of FAILED password sign-ins (helpers/password-lockout.ts).
 *
 * The durable half of password-guessing defence. The per-account Redis limiter
 * (middleware/login-limiter.ts) is the first line, but it fails OPEN on a store
 * error; this counter lives in Mongo — which a password sign-in already needs —
 * so guessing stays bounded through a Redis outage.
 *
 * Its own collection rather than fields on `User` for the reason `UserTotp`
 * has one: a failed attempt writes here, and doing that on the user document
 * would contend with the token-version / refresh-session writes every sign-in
 * makes. A document exists only while a run is in progress or a lockout is
 * live: `expiresAt` (TTL index) drops it once the counting window — or the
 * lockout — has passed, so a typo months ago never counts toward today.
 *
 * IN-FLIGHT RESERVATIONS. A sign-in reserves an attempt here BEFORE it compares
 * the password (`reservePasswordAttempt`), and only while the account is not
 * locked and `failedAttempts + live reservations < maxFailures` — so a burst of
 * parallel guesses can never run more password checks than the limit allows.
 * Each reservation carries its own short expiry, so one left behind by a crash
 * mid-check stops counting by itself; nothing has to clean it up.
 *
 * Removed with the user in `services/user-cascade.ts`.
 */
export interface PasswordAttemptReservation {
  /** Random id, so the request that made it can convert or release exactly it. */
  id: string;
  /** When the reservation stops counting (a crashed request's slot frees itself). */
  exp: Date;
}

export interface PasswordLoginLockoutData {
  userId: Types.ObjectId;
  /** Failed password attempts in the current window. */
  failedAttempts: number;
  /** Set once `failedAttempts` reaches the limit; password sign-in is refused
   *  until it passes, whatever the password. */
  lockedUntil?: Date | null;
  /** Password checks currently in flight (see above). */
  reservations?: PasswordAttemptReservation[];
  /** TTL: when this record stops mattering (end of the window, or of the lockout). */
  expiresAt: Date;
}

export type PasswordLoginLockoutDocument = HydratedDocument<PasswordLoginLockoutData>;

const passwordLoginLockoutSchema = new Schema<PasswordLoginLockoutData>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    failedAttempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
    reservations: {
      type: [{ _id: false, id: { type: String, required: true }, exp: { type: Date, required: true } }],
      default: [],
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);

passwordLoginLockoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<PasswordLoginLockoutData>('PasswordLoginLockout', passwordLoginLockoutSchema);
