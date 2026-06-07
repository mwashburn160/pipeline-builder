// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document, Types } from 'mongoose';

/**
 * Roles a group can grant its members, highest authority first. A user's
 * effective org role is the highest `grantsRole` across the groups they belong
 * to in that org (the `owner` role is separate and ranks above all of these —
 * see {@link ../services/groups-service}). `superadmin` additionally sets the
 * platform-wide `User.isSuperAdmin` flag.
 */
export const GROUP_ROLES = ['superadmin', 'admin', 'member'] as const;
export type GroupRole = typeof GROUP_ROLES[number];

/**
 * A named permission group inside an organization (e.g. the seeded
 * "Administrators" / "Developers", or the system org's "Superadmins").
 * Group membership *drives* the cached `UserOrganization.role` so the existing
 * authz path (JWT role, requireRole, canAdministerOrg) is unchanged.
 */
export interface GroupDocument extends Document {
  /** Owning org id (Mixed: ObjectId for normal orgs, string for 'system'). */
  organizationId: Types.ObjectId | string;
  name: string;
  grantsRole: GroupRole;
  /** Seeded default group — protected from deletion/rename in the API. */
  system: boolean;
}

const groupSchema = new Schema<GroupDocument>(
  {
    organizationId: { type: Schema.Types.Mixed, required: true, index: true },
    name: { type: String, required: true },
    grantsRole: { type: String, enum: GROUP_ROLES as unknown as string[], default: 'member' },
    system: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'groups' },
);

// One group name per org.
groupSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model<GroupDocument>('Group', groupSchema);
