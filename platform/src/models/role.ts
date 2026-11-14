// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ROLE_GRANTS, SEED_BUNDLE_IDS, type RoleGrant, type SeedBundleId } from '@pipeline-builder/api-core';
import { Schema, model, Types, type HydratedDocument } from 'mongoose';

/*
 * The coarse org roles a Role can grant its members (`ROLE_GRANTS`, highest
 * authority first) are api-core's wire vocabulary. A user's effective org role
 * is the highest `grantsRole` across the Roles they are assigned in that org
 * (the `owner` role is separate and ranks above all of these — see
 * {@link ../services/roles-service}). `superadmin` additionally sets the
 * platform-wide `User.isSuperAdmin` flag.
 */

/*
 * Named seed bundles for built-in Roles whose permissions are NOT derived from
 * their `grantsRole`. `ecosystem_manager` is the system org's "Ecosystem
 * Manager" (docs/permissions.md): it grants the coarse
 * `member` label but carries api-core `ECOSYSTEM_MANAGER_PERMISSIONS`. The key
 * is what distinguishes it from the built-in Member Role (same `grantsRole`,
 * both `system: true`), so the Member-floor lookups filter `seedBundle: null`.
 *
 * `team_lead` is the same shape for the person who reports UPWARD: the coarse
 * `member` label plus api-core `TEAM_LEAD_PERMISSIONS` (member + `reports:write`
 * + `reports:publish`). It exists so a reporting lead does not have to be an org
 * admin — carrying members:manage, roles:manage and billing — just to send their
 * manager a weekly summary.
 *
 * Seed-bundle ids are api-core's `SEED_BUNDLE_IDS`, keyed off the `SEED_BUNDLES`
 * table that also carries each bundle's permissions and its seeded Role NAME.
 * One list, so the mongoose enum, the bundle resolver and the staffing roster
 * cannot drift apart — they did, and a bundle present in one and absent from
 * another failed silently.
 */

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
  seedBundle?: SeedBundleId;
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
    seedBundle: { type: String, enum: [...SEED_BUNDLE_IDS] },
  },
  { timestamps: true, collection: 'roles' },
);

// One Role name per org.
roleSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default model<RoleData>('Role', roleSchema);
