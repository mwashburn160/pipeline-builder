// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document, Types } from 'mongoose';

/**
 * Membership role within an organization, in canonical order
 * (highest authority first).
 * - owner: created the org or received ownership transfer
 * - admin: can manage members and org settings
 * - member: standard access
 *
 * Exposed as a `const` tuple so the same source backs both the runtime
 * Mongoose enum and the compile-time `OrgMemberRole` union. Peer models
 * (e.g. invitations) import this to stay in lockstep.
 */
export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;

/** Per-org role string, derived from `MEMBER_ROLES`. */
export type OrgMemberRole = typeof MEMBER_ROLES[number];

/**
 * UserOrganization document interface.
 * Junction collection linking users to organizations with per-org roles.
 */
export interface UserOrganizationDocument extends Document {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  role: OrgMemberRole;
  isActive: boolean;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userOrganizationSchema = new Schema<UserOrganizationDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    role: {
      type: String,
      enum: MEMBER_ROLES as unknown as string[],
      default: 'member',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Prevent duplicate memberships
userOrganizationSchema.index({ userId: 1, organizationId: 1 }, { unique: true });

// List active members of an org, optionally filtered by role
userOrganizationSchema.index({ organizationId: 1, isActive: 1, role: 1 });

// List all orgs for a user
userOrganizationSchema.index({ userId: 1 });

// Enforce at most one owner per organization at the database level. A
// partial unique index keyed on (organizationId, role) but only over
// `role: 'owner'` rows means MongoDB rejects a second owner insert with
// E11000 — eliminating the race where two concurrent ownership-transfer
// requests both succeed before the application-level check runs. Admins
// and members are unaffected (the partial filter excludes them).
userOrganizationSchema.index(
  { organizationId: 1, role: 1 },
  { unique: true, partialFilterExpression: { role: 'owner' } },
);

export default model<UserOrganizationDocument>('UserOrganization', userOrganizationSchema);
