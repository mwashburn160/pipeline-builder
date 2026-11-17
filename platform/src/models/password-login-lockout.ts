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
 * Removed with the user in `services/user-cascade.ts`.
 */
export interface PasswordLoginLockoutData {
  userId: Types.ObjectId;
  /** Failed password attempts in the current window. */
  failedAttempts: number;
  /** Set once `failedAttempts` reaches the limit; password sign-in is refused
   *  until it passes, whatever the password. */
  lockedUntil?: Date | null;
  /** TTL: when this record stops mattering (end of the window, or of the lockout). */
  expiresAt: Date;
}

export type PasswordLoginLockoutDocument = HydratedDocument<PasswordLoginLockoutData>;

const passwordLoginLockoutSchema = new Schema<PasswordLoginLockoutData>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    failedAttempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);

passwordLoginLockoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<PasswordLoginLockoutData>('PasswordLoginLockout', passwordLoginLockoutSchema);
