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
  | 'pipelines:publish'
  // Golden-path pipeline templates. Split out of `pipelines:*` so a platform
  // team can curate the starter catalog WITHOUT write access to every pipeline
  // (and vice versa) — the two used to share one gate. `:publish` maps to the
  // template ladder's `public` rung; `org` and `private` need only `:write`.
  | 'templates:read'
  | 'templates:write'
  | 'templates:publish'
  // Plugins
  | 'plugins:read'
  | 'plugins:write'
  | 'plugins:publish'
  // Compliance
  | 'compliance:read'
  | 'compliance:write'
  // Members & access
  | 'members:manage'
  | 'roles:manage'
  | 'invitations:manage'
  // Org-scoped service accounts (non-human principals) and their access keys.
  // Split out of `members:manage` because a service account is a CREDENTIAL
  // holder, not a person: granting someone the ability to mint long-lived
  // machine keys is a different decision from letting them manage the roster.
  | 'service_accounts:manage'
  // Observability
  | 'dashboards:read'
  | 'dashboards:write'
  | 'observability:read'
  | 'observability:write'
  // `logs:export` is split OUT of `observability:read` deliberately. Reading
  // logs in the UI is paged and ephemeral; EXPORTING them is bulk egress that
  // leaves the building and outlives a revoked session, so an org admin must be
  // able to grant log viewing without granting downloads.
  | 'logs:export'
  // Insights
  | 'reports:read'
  | 'reports:rollup'
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
  // Organization settings.
  //  - `org:settings` — general org settings + AI config.
  //  - `org:idp`      — SSO / IdP configuration (sensitive: controls login).
  //  - `org:kms`      — customer-managed KMS key configuration (sensitive:
  //                     controls encryption of org data).
  //  - `org:impersonation` — the impersonation policy (sensitive: controls who
  //                     may VIEW the org's data as one of its members).
  // `org:idp`/`org:kms`/`org:impersonation` were split OUT of `org:settings` so a
  // custom role can grant general settings WITHOUT the sensitive surfaces — a
  // "settings manager" role for org name or AI provider must not also be able to
  // switch the org to `open`. All remain org-assignable and are seeded into the
  // admin/owner bundles (via ORG_ASSIGNABLE_PERMISSIONS) so existing admins keep
  // full access.
  | 'org:settings'
  | 'org:idp'
  | 'org:kms'
  | 'org:impersonation';

/** All valid permissions (order determines display order in the picker). */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'pipelines:read', 'pipelines:write', 'pipelines:publish',
  'templates:read', 'templates:write', 'templates:publish',
  'plugins:read', 'plugins:write', 'plugins:publish',
  'compliance:read', 'compliance:write',
  'members:manage', 'roles:manage', 'invitations:manage', 'service_accounts:manage',
  'dashboards:read', 'dashboards:write',
  'observability:read', 'observability:write',
  'logs:export',
  'reports:read', 'reports:rollup',
  'messages:read', 'messages:write',
  'billing:read', 'billing:manage',
  'quotas:read',
  'registry:read', 'registry:write',
  'org:settings', 'org:idp', 'org:kms', 'org:impersonation',
];

/**
 * The CLOSED set of functions that take a {@link Permission} and decide access.
 *
 * "Is permission X enforced anywhere?" has to be answerable statically, and it
 * used to not be: four different call shapes consumed a permission id
 * (`requirePermission('x')` at a route, `userHasPermission(req, 'x')` inside a
 * controller, and `resolveVisibility(req, v, 'x')` /
 * `requireVisibilityWriteAccess(…, 'x')` in the visibility helpers), so a naive
 * grep for a route-level gate reported `templates:publish` as UNENFORCED when it
 * is in fact enforced on every template publish.
 *
 * They all bottom out in `userHasPermission`, so the RUNTIME primitive was
 * already one. This constant makes the STATIC surface one as well: it names
 * every entry point, so `permission-coverage.test.ts` can enumerate the catalog
 * and report each permission's enforcement sites without guessing. A new gate
 * that takes a `Permission` must be listed here, or the coverage report starts
 * lying about the permissions only that gate enforces.
 */
export const PERMISSION_GATES: readonly string[] = [
  // Middleware gates (route level) — all any-of except requireAllPermissions.
  'requirePermission',
  'requireAllPermissions',
  'requirePermissionOrService',
  // The single runtime primitive every gate above delegates to; also called
  // directly where a controller branches on a capability rather than rejecting.
  'userHasPermission',
  'hasPermission',
  // Visibility helpers — they take the entity's PUBLISH permission.
  'requireVisibilityWriteAccess',
  'checkVisibilityWriteAccess',
  'resolveVisibility',
];

/**
 * Display metadata for one permission: the label + description the
 * permission-picker UI shows, and the category it groups under.
 */
export interface PermissionMeta {
  id: Permission;
  label: string;
  description: string;
  category: string;
}

/**
 * The permission catalog with display metadata, in picker order.
 *
 * This module is the SINGLE catalog for backend and browser alike: it has no
 * runtime dependencies (the only import is a type), so the frontend imports it
 * through the `@pipeline-builder/api-core/permissions` subpath instead of keeping
 * a hand-maintained mirror. Every id in {@link ALL_PERMISSIONS} must appear here
 * exactly once (asserted by `permissions.test.ts`).
 */
export const PERMISSION_CATALOG: readonly PermissionMeta[] = [
  { id: 'pipelines:read', label: 'View pipelines', description: 'View pipelines and their executions', category: 'Pipelines' },
  { id: 'pipelines:write', label: 'Manage pipelines', description: 'Create, edit, and delete pipelines', category: 'Pipelines' },
  { id: 'pipelines:publish', label: 'Publish pipelines', description: 'Make pipelines public (org-wide/catalog visibility)', category: 'Pipelines' },
  { id: 'templates:read', label: 'View templates', description: 'View the golden-path template catalog', category: 'Templates' },
  { id: 'templates:write', label: 'Manage templates', description: 'Author, edit, and delete pipeline templates', category: 'Templates' },
  { id: 'templates:publish', label: 'Publish templates', description: 'Share a template beyond your org (public visibility)', category: 'Templates' },
  { id: 'plugins:read', label: 'View plugins', description: 'View plugins and builds', category: 'Plugins' },
  { id: 'plugins:write', label: 'Manage plugins', description: 'Create, upload, edit, and delete plugins', category: 'Plugins' },
  { id: 'plugins:publish', label: 'Publish plugins', description: 'Make plugins public (org-wide/catalog visibility)', category: 'Plugins' },
  { id: 'compliance:read', label: 'View compliance', description: 'View compliance rules, policies, and scans', category: 'Compliance' },
  { id: 'compliance:write', label: 'Manage compliance', description: 'Create and edit rules, policies, and exemptions', category: 'Compliance' },
  { id: 'members:manage', label: 'Manage members', description: 'Add, remove, and change roles of org members', category: 'Members & Access' },
  { id: 'roles:manage', label: 'Manage roles', description: 'Create, edit, and delete roles', category: 'Members & Access' },
  { id: 'invitations:manage', label: 'Manage invitations', description: 'Send, resend, and revoke invitations', category: 'Members & Access' },
  { id: 'service_accounts:manage', label: 'Manage service accounts', description: 'Create org service accounts, assign their roles, and issue or revoke their keys', category: 'Members & Access' },
  { id: 'dashboards:read', label: 'View dashboards', description: 'View custom dashboards', category: 'Observability' },
  { id: 'dashboards:write', label: 'Manage dashboards', description: 'Create and edit custom dashboards', category: 'Observability' },
  { id: 'observability:read', label: 'View alerting', description: 'View alert rules and destinations', category: 'Observability' },
  { id: 'observability:write', label: 'Manage alerting', description: 'Create and edit alert rules and destinations', category: 'Observability' },
  { id: 'logs:export', label: 'Download logs', description: "Download your organization's log entries as a file (viewing logs only needs 'View alerting')", category: 'Observability' },
  { id: 'reports:read', label: 'View reports', description: 'View analytics and reports', category: 'Insights' },
  { id: 'reports:rollup', label: 'Roll up team reports', description: 'Include descendant teams when viewing reports', category: 'Insights' },
  { id: 'messages:read', label: 'View messages', description: 'View messages and announcements', category: 'Messaging' },
  { id: 'messages:write', label: 'Send messages', description: 'Send messages and announcements', category: 'Messaging' },
  { id: 'billing:read', label: 'View billing', description: 'View subscriptions and usage', category: 'Billing & Quotas' },
  { id: 'billing:manage', label: 'Manage billing', description: 'Manage subscriptions, add-ons, and the billing portal', category: 'Billing & Quotas' },
  { id: 'quotas:read', label: 'View quotas', description: 'View organization quotas and usage', category: 'Billing & Quotas' },
  { id: 'registry:read', label: 'View registry', description: 'View the container image registry', category: 'Registry' },
  { id: 'registry:write', label: 'Manage registry', description: 'Delete and copy container images', category: 'Registry' },
  { id: 'org:settings', label: 'Organization settings', description: 'Manage general org settings and AI config', category: 'Organization' },
  { id: 'org:idp', label: 'Manage SSO/IdP', description: 'Configure single sign-on and identity providers', category: 'Organization' },
  { id: 'org:kms', label: 'Manage encryption keys', description: 'Configure customer-managed KMS encryption keys', category: 'Organization' },
  { id: 'org:impersonation', label: 'Manage impersonation policy', description: 'Control whether platform operators may view the organization as one of its members', category: 'Organization' },
];

const PERMISSION_LABELS = new Map<string, string>(PERMISSION_CATALOG.map((p) => [p.id, p.label]));

/** Human label for a permission id (falls back to the raw id for an unknown one). */
export function permissionLabel(id: string): string {
  return PERMISSION_LABELS.get(id) ?? id;
}

/** One picker section: a category and the permissions it contains, in catalog order. */
export interface PermissionCategory {
  category: string;
  permissions: PermissionMeta[];
}

/** Group a permission list into categories, preserving catalog order. */
function groupByCategory(perms: readonly PermissionMeta[]): PermissionCategory[] {
  const order: string[] = [];
  const byCategory = new Map<string, PermissionMeta[]>();
  for (const p of perms) {
    if (!byCategory.has(p.category)) { byCategory.set(p.category, []); order.push(p.category); }
    byCategory.get(p.category)!.push(p);
  }
  return order.map((category) => ({ category, permissions: byCategory.get(category)! }));
}

/** Check whether a string is a valid Permission. */
export function isValidPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions that must NEVER be grantable through a user-authored CUSTOM Role —
 * they gate platform-operator surfaces (the shared image registry), so allowing
 * an org admin to mint a Role carrying them would be a latent privilege
 * escalation. They are NOT seeded into ANY built-in Role bundle (neither
 * `member` nor `admin`), so the only holder is a superadmin (implicit-all) —
 * which is what makes the image-registry gates that require them effectively
 * superadmin-only. This list ALSO blocks custom-Role authoring from requesting
 * them (see platform `sanitizePermissions`).
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

/**
 * Category → permissions for the custom-Role AUTHORING picker: the catalog minus
 * the {@link SUPERADMIN_ONLY_PERMISSIONS}, with any now-empty category dropped
 * (so "Registry" disappears). The grouped view of
 * {@link ORG_ASSIGNABLE_PERMISSIONS}.
 */
export const ORG_ASSIGNABLE_CATEGORIES: readonly PermissionCategory[] =
  groupByCategory(PERMISSION_CATALOG.filter((p) => isOrgAssignablePermission(p.id)));

// =============================================================================
// Permission-scoped credentials (personal access keys / machine tokens)
// =============================================================================

/**
 * Every `:read` permission — the "read-only" preset a new personal access key
 * starts from. Derived from the catalog so a new resource's read permission
 * joins the preset without a second edit.
 */
export const READ_ONLY_PERMISSIONS: readonly Permission[] =
  ALL_PERMISSIONS.filter((p) => p.endsWith(':read'));

/**
 * Normalize a requested permission subset: every entry must be a catalog id
 * (anything else → `null`, the caller's 400), duplicates collapse, and the
 * result is in canonical catalog order so a stored subset compares stably.
 * An EMPTY array is valid — a key that can authenticate but do nothing — and
 * is distinct from "no subset" (`undefined`), which means full access.
 */
export function normalizePermissionSubset(requested: readonly unknown[]): Permission[] | null {
  const wanted = new Set<string>();
  for (const p of requested) {
    if (typeof p !== 'string' || !isValidPermission(p)) return null;
    wanted.add(p);
  }
  return ALL_PERMISSIONS.filter((p) => wanted.has(p));
}

/**
 * The permissions a permission-scoped credential actually carries: the
 * INTERSECTION of the subset it was created with and the holder's CURRENT
 * effective permissions, in catalog order. Re-evaluated at every issue, so
 * losing a Role shrinks the credential and nothing can ever grow it past the
 * subset it was created with.
 */
export function intersectPermissions(
  effective: readonly string[],
  subset: readonly string[],
): Permission[] {
  const allowed = new Set(subset);
  const held = new Set(effective);
  return ALL_PERMISSIONS.filter((p) => allowed.has(p) && held.has(p));
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
 * - `member`  — day-to-day builder: read + write on pipelines/templates/plugins,
 *   read elsewhere. No member/role/billing management, no compliance/alert
 *   authoring, and no `:publish` on any catalog.
 * - `admin`   — full org administration: every ORG-ASSIGNABLE permission (i.e.
 *   ALL_PERMISSIONS minus the {@link SUPERADMIN_ONLY_PERMISSIONS}, so `registry:*`
 *   stay superadmin-implicit-only and are NOT granted to org admins).
 * - `owner`   — same as admin (ownership itself — transfer/delete — is gated
 *   separately, not via a permission).
 */
const MEMBER_PERMISSIONS: readonly Permission[] = [
  'pipelines:read', 'pipelines:write',
  'templates:read', 'templates:write',
  'plugins:read', 'plugins:write',
  'compliance:read',
  'dashboards:read',
  'observability:read',
  'reports:read',
  'messages:read', 'messages:write',
  'billing:read',
  'quotas:read',
];

const ADMIN_PERMISSIONS: readonly Permission[] = [...ORG_ASSIGNABLE_PERMISSIONS];

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
