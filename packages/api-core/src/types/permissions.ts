// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from './common.js';

// =============================================================================
// Permission identifiers
// =============================================================================

/**
 * Canonical fine-grained permission identifiers, in `resource:action` form.
 *
 * These are the ORG-SCOPED capabilities a group can grant (RBAC). Coarse by
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
  | 'groups:manage'
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
  'members:manage', 'groups:manage', 'invitations:manage',
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

// =============================================================================
// Role → permission bundles
// =============================================================================

/**
 * Default permission bundle for each org role. Seeds the built-in groups and
 * provides a user's baseline permissions (unioned with any custom-group grants).
 *
 * - `member`  — day-to-day builder: read + write on pipelines/plugins, read
 *   elsewhere. No member/group/billing management, no compliance/alert authoring.
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

export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  member: MEMBER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  owner: ADMIN_PERMISSIONS,
};

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a user's effective org permissions.
 *
 * 1. Platform superadmins (isSuperAdmin) always get ALL permissions.
 * 2. Start from the base role's bundle ({@link ROLE_PERMISSIONS}).
 * 3. Union in every permission granted by the user's custom groups.
 * 4. Invalid permission strings are silently ignored.
 *
 * @param role - The user's org role (owner/admin/member)
 * @param groupPermissions - Flattened permissions from all of the user's groups
 * @param isSuperAdmin - Whether the user has the global super-admin flag
 * @returns Sorted array of effective permissions (canonical order)
 */
export function resolveUserPermissions(
  role: OrgRole,
  groupPermissions?: readonly string[] | null,
  isSuperAdmin?: boolean,
): Permission[] {
  if (isSuperAdmin) return [...ALL_PERMISSIONS];

  const perms = new Set<Permission>(ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.member);
  if (groupPermissions) {
    for (const p of groupPermissions) {
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
