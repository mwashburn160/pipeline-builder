// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Types, type HydratedDocument } from 'mongoose';

/**
 * A user's request to join an existing organization via domain-based discovery,
 * for domains configured with `autoJoin: 'request'`. An org admin
 * approves (→ creates the membership) or denies. Unique per (organizationId, userId) so a
 * user can't stack duplicate pending requests against the same org.
 */
export type JoinRequestStatus = 'pending' | 'approved' | 'denied';
const JOIN_REQUEST_STATUSES: readonly JoinRequestStatus[] = ['pending', 'approved', 'denied'];

export interface JoinRequestData {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  /** Provider-verified email at request time — recorded for the admin's context. */
  email: string;
  status: JoinRequestStatus;
  decidedBy?: Types.ObjectId;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type JoinRequestDocument = HydratedDocument<JoinRequestData>;

const joinRequestSchema = new Schema<JoinRequestData>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    email: { type: String, required: true, lowercase: true },
    status: { type: String, enum: [...JOIN_REQUEST_STATUSES], default: 'pending' },
    decidedBy: { type: Schema.Types.ObjectId },
    decidedAt: { type: Date },
  },
  { timestamps: true, collection: 'join_requests' },
);

// One request per (org, user) — a re-request updates the existing row.
joinRequestSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
// Admin listing of pending requests for an org.
joinRequestSchema.index({ organizationId: 1, status: 1 });

export default model<JoinRequestData>('JoinRequest', joinRequestSchema);
