// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Types, type HydratedDocument } from 'mongoose';

/**
 * A forgot-password token (`POST /auth/password/reset-request` →
 * `POST /auth/password/reset`).
 *
 * Only the SHA-256 of the emailed secret is stored, so a database read never
 * yields a usable link. A token is SINGLE-USE: the reset claims it with an
 * atomic `findOneAndDelete`, so two concurrent submissions of the same link
 * produce exactly one password change. At most one live token per account —
 * issuing a new one deletes the previous ones.
 *
 * `expiresAt` carries a TTL index, so an unclaimed token disappears on its own;
 * the reset ALSO filters `expiresAt > now`, because the TTL monitor runs about
 * once a minute and must not be the thing that decides validity.
 */
export interface PasswordResetTokenData {
  userId: Types.ObjectId;
  /** sha256(raw token), hex. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export type PasswordResetTokenDocument = HydratedDocument<PasswordResetTokenData>;

const passwordResetTokenSchema = new Schema<PasswordResetTokenData>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'password_reset_tokens', versionKey: false },
);

passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model<PasswordResetTokenData>('PasswordResetToken', passwordResetTokenSchema);
