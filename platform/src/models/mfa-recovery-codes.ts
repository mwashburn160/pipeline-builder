// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * One account's MFA RECOVERY CODES — a single set per person, whatever their
 * second factor is.
 *
 * Its own collection (not part of the authenticator-app enrolment) because the
 * codes back up the ACCOUNT, not one factor: a person whose first factor was a
 * passkey gets a set at that moment, and adding an authenticator app later
 * shares the same set rather than minting a second sheet nobody could keep
 * straight. The set is removed when the account's last factor goes (and by an
 * MFA reset), since a recovery code without a factor to recover is just a
 * password in disguise.
 *
 * Codes are stored as SHA-256 hashes of the normalized value (see
 * `utils/totp.ts#hashRecoveryCode`) and are single-use; spent entries are KEPT
 * so the UI can count what is left and a reused code is refused as spent.
 *
 * `failedAttempts` / `lockedUntil` bound guessing on the RECOVERY-ONLY sign-in
 * leg (an account with no authenticator app to share a lockout with). An
 * account WITH an authenticator app counts recovery-code failures on its TOTP
 * enrolment instead, so the two can't be guessed on separate budgets.
 *
 * Removed with the user in `services/user-cascade.ts`.
 */
export interface MfaRecoveryCodesDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  codes: Array<{ hash: string; usedAt?: Date | null }>;
  generatedAt: Date;
  failedAttempts: number;
  lockedUntil?: Date | null;
}

const mfaRecoveryCodesSchema = new Schema<MfaRecoveryCodesDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    codes: {
      type: [{ _id: false, hash: { type: String, required: true }, usedAt: { type: Date, default: null } }],
      default: [],
      // Never selected by accident — only the recovery-code service reads hashes.
      select: false,
    },
    generatedAt: { type: Date, default: Date.now },
    failedAttempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: false },
);

export default mongoose.model<MfaRecoveryCodesDocument>('MfaRecoveryCodes', mfaRecoveryCodesSchema);
