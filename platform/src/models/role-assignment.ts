// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document, Types } from 'mongoose';

/**
 * Junction linking a PRINCIPAL to a {@link ./role}. A principal can hold several
 * Roles within an org; their effective role/permissions are derived from the
 * union (see {@link ../services/roles-service}). `organizationId` is denormalized
 * so assignments can be queried per-org without a Role join.
 *
 * Exactly ONE principal field is set:
 *   - `userId` — a person (the original and overwhelmingly common case);
 *   - `serviceAccountId` — an org service account (#2), which holds its Roles
 *     through this same collection rather than a parallel mechanism.
 *
 * Every user-facing query filters on `userId`, so a service account's
 * assignments never leak into a person's role resolution (and vice versa).
 */

/**
 * WHO put this assignment here.
 *
 * - `manual` — a person granted it (the Role-membership API, an invitation's
 *   role, the built-in Admin/Member floors). NEVER removed by an automated sync.
 * - `jit`    — derived from an IdP group mapping at SSO sign-in (3a; SCIM reuses
 *   it in 3b). Owned by the sync: when the group stops mapping to the Role, the
 *   row goes away with it.
 *
 * The distinction is the whole reason the field exists — a sync that could not
 * tell the two apart would either strip Roles an admin granted by hand or leave
 * IdP-derived Roles behind after the IdP revoked the group.
 */
export const ROLE_ASSIGNMENT_SOURCES = ['manual', 'jit'] as const;
export type RoleAssignmentSource = typeof ROLE_ASSIGNMENT_SOURCES[number];

export interface RoleAssignmentDocument extends Document {
  userId?: Types.ObjectId | null;
  serviceAccountId?: Types.ObjectId | null;
  roleId: Types.ObjectId;
  /** Denormalized owning-org/team id (mirrors the Role's org). */
  organizationId: Types.ObjectId;
  /** Provenance — see {@link RoleAssignmentSource}. Defaults to `manual`. */
  source: RoleAssignmentSource;
}

const roleAssignmentSchema = new Schema<RoleAssignmentDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    serviceAccountId: { type: Schema.Types.ObjectId, ref: 'ServiceAccount', default: null, index: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
    source: { type: String, enum: ROLE_ASSIGNMENT_SOURCES as unknown as string[], default: 'manual' },
  },
  { timestamps: true, collection: 'role_assignments' },
);

// A principal holds a given Role at most once. Both uniqueness indexes are
// PARTIAL on their own principal field: without that, every service-account row
// would share a `userId: null` key and two different accounts holding the SAME
// Role would collide on (null, roleId).
roleAssignmentSchema.index(
  { userId: 1, roleId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } },
);
roleAssignmentSchema.index(
  { serviceAccountId: 1, roleId: 1 },
  { unique: true, partialFilterExpression: { serviceAccountId: { $type: 'objectId' } } },
);
// Resolve a principal's Roles within an org (role/permission derivation). The
// sync path additionally filters on `source`, which this index still serves.
roleAssignmentSchema.index({ organizationId: 1, userId: 1 });
roleAssignmentSchema.index({ organizationId: 1, serviceAccountId: 1 });

export default model<RoleAssignmentDocument>('RoleAssignment', roleAssignmentSchema);
