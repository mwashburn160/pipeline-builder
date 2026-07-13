// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document, Types } from 'mongoose';

/**
 * Junction linking a user to a {@link ./role}. A user can hold several Roles
 * within an org; their effective role is derived from the union (see
 * {@link ../services/roles-service}). `organizationId` is denormalized so
 * assignments can be queried per-org without a Role join.
 */
export interface RoleAssignmentDocument extends Document {
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  /** Denormalized owning-org/team id (mirrors the Role's org). */
  organizationId: Types.ObjectId;
}

const roleAssignmentSchema = new Schema<RoleAssignmentDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, collection: 'role_assignments' },
);

// A user holds a given Role at most once.
roleAssignmentSchema.index({ userId: 1, roleId: 1 }, { unique: true });
// Resolve a user's Roles within an org (role derivation).
roleAssignmentSchema.index({ organizationId: 1, userId: 1 });

export default model<RoleAssignmentDocument>('RoleAssignment', roleAssignmentSchema);
