// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Types, type HydratedDocument } from 'mongoose';

/**
 * One account's authenticator-app enrolment (TOTP). The account's recovery
 * codes live in `MfaRecoveryCodes` — one set per account, shared with passkeys.
 *
 * Its OWN collection rather than fields on `User`, for the same reasons passkeys
 * got one:
 *   1. Every verification writes `lastUsedStep` (replay protection) and, on a
 *      failure, the lockout counters. Doing that on the user document would
 *      contend with the token-version and refresh-session writes that already
 *      run there on every sign-in.
 *   2. The secret is `select: false` material that no
 *      profile read should ever be one forgotten projection away from.
 *
 * `secret` is a JSON-stringified `EncryptedBlob` (AES-256-GCM, see
 * `utils/secret-blob.ts`) whose key is derived for the salt `user:<userId>` —
 * so a stolen row cannot be replayed under another account, and a database dump
 * without `SECRET_ENCRYPTION_KEY` yields nothing. It NEVER leaves
 * `services/totp-service.ts` in clear text after enrolment.
 *
 * A document exists from the moment enrolment starts; `activatedAt` is what
 * makes it a factor. An enrolment that was never confirmed is simply replaced by
 * the next one, and is invisible to `authFactors.hasTotp`.
 *
 * Removed with the user in `services/user-cascade.ts`.
 */
export interface UserTotpData {
  /** Owning user. One enrolment per account — a second authenticator app is
   *  scanned from the same secret, which is how every provider does it. */
  userId: Types.ObjectId;
  /** JSON-encoded `EncryptedBlob` of the base32 secret. */
  secret: string;
  /** When the first correct code confirmed the enrolment. Null = pending. */
  activatedAt?: Date | null;
  /**
   * The highest time step a code has been accepted for.
   *
   * Replay protection: a verification only accepts a step STRICTLY GREATER than
   * this, so a code shoulder-surfed (or captured from a phishing proxy) inside
   * its own 30-second window can't be spent a second time — and neither can an
   * earlier step still inside the drift allowance.
   */
  lastUsedStep: number;
  /** Consecutive failed codes (generated OR recovery) since the last success.
   *  Reset on any success. */
  failedAttempts: number;
  /** Set once `failedAttempts` crosses the threshold; every verification is
   *  refused until it passes, whether the code is generated or a recovery code. */
  lockedUntil?: Date | null;
  createdAt: Date;
  /** Last successful verification (sign-in or step-up), for the settings page. */
  lastUsedAt?: Date | null;
}

export type UserTotpDocument = HydratedDocument<UserTotpData>;

const userTotpSchema = new Schema<UserTotpData>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    // Hidden from default queries — only totp-service ever reads it, and it
    // decrypts immediately rather than passing the blob around.
    secret: { type: String, required: true, select: false },
    activatedAt: { type: Date, default: null },
    lastUsedStep: { type: Number, required: true, default: 0 },
    failedAttempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
  },
  // `createdAt` is written explicitly (and shown in the UI); `activatedAt` and
  // `lastUsedAt` say everything an `updatedAt` would.
  { timestamps: false },
);

export default mongoose.model<UserTotpData>('UserTotp', userTotpSchema);
