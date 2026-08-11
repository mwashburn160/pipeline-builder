// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * A named, individually-revocable Personal Access Token (PAT).
 *
 * Unlike the coarse `tokenVersion` bump (which invalidates ALL of a user's
 * sessions), a PAT is tracked by its `jti` claim so it can be revoked on its
 * own. `requireAuth` looks up the presented token's `jti` here and rejects it
 * when the record is revoked or expired. The token secret itself is never
 * stored — only this metadata.
 */
export interface PersonalAccessTokenDocument extends Document {
  userId: Types.ObjectId;
  /** Matches the `jti` claim in the issued JWT. */
  jti: string;
  /** User-supplied label. */
  name: string;
  /** Optional narrow scope (least-privilege). Null → the user's full permissions. */
  scope?: string | null;
  /** Org the token was minted against (for display/audit). */
  organizationId?: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt?: Date | null;
  revoked: boolean;
  revokedAt?: Date | null;
}

const personalAccessTokenSchema = new Schema<PersonalAccessTokenDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    jti: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    scope: { type: String, default: null },
    organizationId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    revoked: { type: Boolean, default: false },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export default mongoose.model<PersonalAccessTokenDocument>('PersonalAccessToken', personalAccessTokenSchema);
