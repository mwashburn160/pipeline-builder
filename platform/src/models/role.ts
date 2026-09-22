// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Types, type HydratedDocument } from 'mongoose';

/**
 * Coarse org roles a Role can grant its members, highest authority first. A
 * user's effective org role is the highest `grantsRole` across the Roles they
 * are assigned in that org (the `owner` role is separate and ranks above all of
 * these — see {@link ../services/roles-service}). `superadmin` additionally sets
 * the platform-wide `User.isSuperAdmin` flag.
 */
export const ROLE_GRANTS = ['superadmin', 'admin', 'member'] as const;
export type RoleGrant = typeof ROLE_GRANTS[number];

/**
 * Named seed bundles for built-in Roles whose permissions are NOT derived from
 * their `grantsRole`. `ecosystem_manager` is the system org's "Ecosystem
 * Manager" (docs/permissions.md): it grants the coarse
 * `member` label but carries api-core `ECOSYSTEM_MANAGER_PERMISSIONS`. The key
 * is what distinguishes it from the built-in Member Role (same `grantsRole`,
 * both `system: true`), so the Member-floor lookups filter `seedBundle: null`.
 */
export const ROLE_SEED_BUNDLES = ['ecosystem_manager'] as const;
export type RoleSeedBundle = typeof ROLE_SEED_BUNDLES[number];

/**
 * A named permission Role inside an organization or team.
 *
 * Two grant mechanisms, unioned at token-issue time (see `resolveUserPermissions`
 * in api-core and `rolePermissionsFor` in services/role-permissions.ts):
 * - `grantsRole` — the seeded Roles (Admin/Member, and the system
 *   org's Super Admin) confer a base org role, which drives the cached
 *   `UserOrganization.role` and the `superadmin` bootstrap. Custom Roles leave
 *   this at the default `'member'` (no role escalation).
 * - `permissions` — a fine-grained `Permission[]` set (api-core catalog) that is
 *   ADDED to the member's effective permissions. This is what custom,
 *   user-defined Roles use.
 */
export interface RoleData {
  /** Owning org/team id. */
  organizationId: Types.ObjectId;
  name: string;
  /** Optional operator-facing description (custom Roles). */
  description?: string;
  grantsRole: RoleGrant;
  /** Fine-grained permissions this Role grants (api-core `Permission` strings). */
  permissions: string[];
  /** Seeded default Role — protected from deletion/rename in the API. */
  system: boolean;
  /** Built-in Roles only: the named seed bundle this Role carries instead of
   *  its `grantsRole` bundle (unset for Admin/Member/Super Admin and every
   *  custom Role). */
  seedBundle?: RoleSeedBundle;
}

export type RoleDocument = HydratedDocument<RoleData>;

const roleSchema = new Schema<RoleData>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String },
    grantsRole: { type: String, enum: [...ROLE_GRANTS], default: 'member' },
    permissions: { type: [String], default: [] },
    system: { type: Boolean, default: false },
    seedBundle: { type: String, enum: [...ROLE_SEED_BUNDLES] },
  },
  { timestamps: true, collection: 'roles' },
);

// One Role name per org.
roleSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model<RoleData>('Role', roleSchema);
