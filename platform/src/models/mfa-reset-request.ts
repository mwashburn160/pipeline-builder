// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Types, type HydratedDocument } from 'mongoose';

/**
 * A TWO-PERSON request to reset one member's second factors.
 *
 * An org admin/owner REQUESTS it (with a reason); a DIFFERENT admin/owner of
 * that org or of an ancestor — or a platform sysadmin — APPROVES or DENIES it.
 * Approval is what runs the reset (`services/mfa-recovery.ts`): every passkey,
 * the authenticator app and the recovery codes are removed, every session ends,
 * and the person gets a bounded per-user enrolment grace (`User.mfaResetGraceUntil`)
 * instead of the org's MFA policy being turned off for everybody.
 *
 * The requester can never approve their own request, nor can the person being
 * reset. A request lives `MFA_RESET_REQUEST_TTL_MS` (24h); after that it is
 * marked `expired` the next time anything touches it, and can never be
 * approved. At most one live (`pending`) request per member per org — enforced
 * by a partial unique index, so two admins racing to file one produce exactly
 * one.
 */
export const MFA_RESET_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export type MfaResetRequestStatus = typeof MFA_RESET_REQUEST_STATUSES[number];

export interface MfaResetRequestData {
  /** The org whose admins may act on the request (the requester's authority). */
  organizationId: Types.ObjectId;
  /** The member whose factors would be removed. */
  targetUserId: Types.ObjectId;
  targetEmail: string;
  requestedBy: Types.ObjectId;
  requestedByEmail: string;
  reason: string;
  status: MfaResetRequestStatus;
  createdAt: Date;
  /** After this a pending request can no longer be approved. */
  expiresAt: Date;
  decidedBy?: Types.ObjectId;
  decidedByEmail?: string;
  decidedAt?: Date;
  /** Why it was denied (optional free text). */
  decisionNote?: string;
  /** What the approved reset removed, and the enrolment grace it granted. */
  result?: {
    passkeysRemoved: number;
    totpRemoved: boolean;
    recoveryCodesRemoved: boolean;
    graceUntil: Date;
  };
}

export type MfaResetRequestDocument = HydratedDocument<MfaResetRequestData>;

const mfaResetRequestSchema = new Schema<MfaResetRequestData>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetEmail: { type: String, required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByEmail: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: MFA_RESET_REQUEST_STATUSES, required: true, default: 'pending' },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedByEmail: { type: String },
    decidedAt: { type: Date },
    decisionNote: { type: String, maxlength: 500 },
    result: {
      type: {
        _id: false,
        passkeysRemoved: { type: Number, required: true },
        totpRemoved: { type: Boolean, required: true },
        recoveryCodesRemoved: { type: Boolean, required: true },
        graceUntil: { type: Date, required: true },
      },
      default: undefined,
    },
  },
  { timestamps: false },
);

// One live request per member per org. Partial, so decided requests pile up as
// history without blocking the next one.
mfaResetRequestSchema.index(
  { organizationId: 1, targetUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export default mongoose.model<MfaResetRequestData>('MfaResetRequest', mfaResetRequestSchema);
