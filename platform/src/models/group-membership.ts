// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document, Types } from 'mongoose';

/**
 * Junction linking a user to a {@link ./group}. A user can be in several groups
 * within an org; their effective role is derived from the union (see
 * {@link ../services/groups-service}). `organizationId` is denormalized so
 * membership can be queried per-org without a group join.
 */
export interface GroupMembershipDocument extends Document {
  userId: Types.ObjectId;
  groupId: Types.ObjectId;
  /** Denormalized owning-org id (Mixed, mirrors the group's org). */
  organizationId: Types.ObjectId | string;
}

const groupMembershipSchema = new Schema<GroupMembershipDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    groupId: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
    organizationId: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, collection: 'group_memberships' },
);

// A user is in a given group at most once.
groupMembershipSchema.index({ userId: 1, groupId: 1 }, { unique: true });
// Resolve a user's groups within an org (role derivation).
groupMembershipSchema.index({ organizationId: 1, userId: 1 });

export default model<GroupMembershipDocument>('GroupMembership', groupMembershipSchema);
