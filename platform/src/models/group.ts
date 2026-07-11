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
 * A named permission group inside an organization or team.
 *
 * Two grant mechanisms, unioned at token-issue time (see `resolveUserPermissions`
 * in api-core and `getUserGroupPermissions` in the groups service):
 * - `grantsRole` — the seeded groups (Administrators/Developers, and the system
 *   org's Superadmins) confer a base org role, which drives the cached
 *   `UserOrganization.role` and the `superadmin` bootstrap. Custom groups leave
 *   this at the default `'member'` (no role escalation).
 * - `permissions` — a fine-grained `Permission[]` set (api-core catalog) that is
 *   ADDED to the member's effective permissions. This is what custom,
 *   user-defined groups use.
 */
export interface GroupDocument extends Document {
  /** Owning org/team id. */
  organizationId: Types.ObjectId;
  name: string;
  /** Optional operator-facing description (custom groups). */
  description?: string;
  grantsRole: GroupRole;
  /** Fine-grained permissions this group grants (api-core `Permission` strings). */
  permissions: string[];
  /** Seeded default group — protected from deletion/rename in the API. */
  system: boolean;
}

const groupSchema = new Schema<GroupDocument>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String },
    grantsRole: { type: String, enum: GROUP_ROLES as unknown as string[], default: 'member' },
    permissions: { type: [String], default: [] },
    system: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'groups' },
);

// One group name per org.
groupSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model<GroupDocument>('Group', groupSchema);
