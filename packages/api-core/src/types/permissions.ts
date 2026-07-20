// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from './common.js';

// =============================================================================
// Permission identifiers
// =============================================================================

/**
 * Canonical fine-grained permission identifiers, in `resource:action` form.
 *
 * These are the ORG-SCOPED capabilities a Role can grant (RBAC). Coarse by
 * design — `:write` covers create/update/delete for a resource — so the catalog
 * and permission-picker UI stay small; split a `:write` into `:create`/`:delete`
 * later if a resource needs it.
 *
 * NOT modeled here (intentionally): platform-operator actions (org delete, tier/
 * quota override, user admin, impersonation, platform settings) stay behind the
 * global `isSuperAdmin` flag, not a per-org permission; and `requireStepUp`
 * (MFA) / `requireFeature` (plan entitlements) remain orthogonal gates.
 */
export type Permission =
  // Pipelines
  | 'pipelines:read'
  | 'pipelines:write'
  // Plugins
  | 'plugins:read'
  | 'plugins:write'
  // Compliance
  | 'compliance:read'
  | 'compliance:write'
  // Members & access
  | 'members:manage'
  | 'roles:manage'
  | 'invitations:manage'
  // Observability
  | 'dashboards:read'
  | 'dashboards:write'
  | 'observability:read'
  | 'observability:write'
  // Insights
  | 'reports:read'
  // Messaging
  | 'messages:read'
  | 'messages:write'
  // Billing & quotas
  | 'billing:read'
  | 'billing:manage'
  | 'quotas:read'
  // Registry
  | 'registry:read'
  | 'registry:write'
  // Organization settings (IdP, KMS, AI config, general settings)
  | 'org:settings';

/** All valid permissions (order determines display order in the picker). */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'pipelines:read', 'pipelines:write',
  'plugins:read', 'plugins:write',
  'compliance:read', 'compliance:write',
  'members:manage', 'roles:manage', 'invitations:manage',
  'dashboards:read', 'dashboards:write',
  'observability:read', 'observability:write',
  'reports:read',
  'messages:read', 'messages:write',
  'billing:read', 'billing:manage',
  'quotas:read',
  'registry:read', 'registry:write',
  'org:settings',
];

/** Check whether a string is a valid Permission. */
export function isValidPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions that must NEVER be grantable through a user-authored CUSTOM Role —
 * they gate platform-operator surfaces (the shared image registry), so allowing
 * an org admin to mint a Role carrying them would be a latent privilege
 * escalation the moment those permissions get wired to an endpoint. Built-in
 * Role seeds (e.g. `member` carrying `registry:read`) are system-created and are
 * NOT subject to this list; it constrains only custom-Role authoring.
 */
export const SUPERADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  'registry:read',
  'registry:write',
];

/**
 * Permissions an org may assign via a CUSTOM Role — every permission except the
 * {@link SUPERADMIN_ONLY_PERMISSIONS}. Custom-Role create/update validates the
 * requested permission set against this (see platform roles-service).
 */
export const ORG_ASSIGNABLE_PERMISSIONS: readonly Permission[] =
  ALL_PERMISSIONS.filter((p) => !SUPERADMIN_ONLY_PERMISSIONS.includes(p));

/** Whether `permission` may be granted through a user-authored custom Role. */
export function isOrgAssignablePermission(permission: Permission): boolean {
  return !SUPERADMIN_ONLY_PERMISSIONS.includes(permission);
}

// =============================================================================
// Built-in Role seed bundles
// =============================================================================

/**
 * Permission bundles used to SEED the built-in Roles ("Admin", "Member").
 *
 * This is the single definition of what those built-in Roles grant — it is used
 * when a Role record is created (and by the startup backfill) to populate that
 * Role's own `permissions[]`. It is NOT a runtime permission source: a user's
 * effective permissions come ONLY from the Roles assigned to them (see
 * {@link resolveUserPermissions}). The coarse `role` label (owner/admin/member)
 * survives only for `isAdmin`/ownership/display, never to grant permissions.
 *
 * - `member`  — day-to-day builder: read + write on pipelines/plugins, read
 *   elsewhere. No member/role/billing management, no compliance/alert authoring.
 * - `admin`   — full org administration (everything below).
 * - `owner`   — same as admin (ownership itself — transfer/delete — is gated
 *   separately, not via a permission).
 */
const MEMBER_PERMISSIONS: readonly Permission[] = [
  'pipelines:read', 'pipelines:write',
  'plugins:read', 'plugins:write',
  'compliance:read',
  'dashboards:read',
  'observability:read',
  'reports:read',
  'messages:read', 'messages:write',
  'billing:read',
  'quotas:read',
  'registry:read',
];

const ADMIN_PERMISSIONS: readonly Permission[] = [...ALL_PERMISSIONS];

/**
 * Seed bundle for each built-in Role, keyed by the coarse role it grants.
 * Consumed by the Role seeder + the startup backfill to populate a built-in
 * Role's `permissions[]`. NOT consulted at request time — see
 * {@link resolveUserPermissions}.
 */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  member: MEMBER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  owner: ADMIN_PERMISSIONS,
};

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a user's effective org permissions from the Roles assigned to them.
 *
 * Single-source model: a user's abilities are EXACTLY the union of the
 * permissions carried by the Roles they hold (a Role = a named permission set;
 * built-in Roles carry their bundle explicitly, seeded from
 * {@link ROLE_PERMISSIONS}). There is no separate role-derived baseline — the
 * coarse `role` label no longer grants anything on its own.
 *
 * 1. Platform superadmins (`isSuperAdmin`) always get ALL permissions.
 * 2. Otherwise, union every permission granted by the user's assigned Roles.
 * 3. Invalid/unknown permission strings are silently ignored.
 *
 * @param assignedPermissions - Flattened permissions from every Role the user holds
 * @param isSuperAdmin - Whether the user has the global super-admin flag
 * @returns Effective permissions in canonical order
 */
export function resolveUserPermissions(
  assignedPermissions?: readonly string[] | null,
  isSuperAdmin?: boolean,
): Permission[] {
  if (isSuperAdmin) return [...ALL_PERMISSIONS];

  const perms = new Set<Permission>();
  if (assignedPermissions) {
    for (const p of assignedPermissions) {
      if (isValidPermission(p)) perms.add(p);
    }
  }
  return ALL_PERMISSIONS.filter(p => perms.has(p));
}

/** Whether a resolved permission list grants `permission` (superadmin ⇒ always). */
export function hasPermission(
  granted: readonly string[] | null | undefined,
  permission: Permission,
  isSuperAdmin?: boolean,
): boolean {
  if (isSuperAdmin) return true;
  return !!granted && granted.includes(permission);
}
