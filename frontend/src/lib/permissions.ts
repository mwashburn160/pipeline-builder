// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Frontend mirror of api-core's permission catalog (types/permissions.ts).
 * Kept local (not imported from `@pipeline-builder/api-core`) so the Next.js
 * bundle never pulls in the package's server-only code (express/jwt). Keep the
 * list and labels in sync with the api-core source of truth — the backend
 * validates every permission against ITS catalog, so an out-of-sync entry here
 * just fails validation, it can't grant anything unknown.
 */

export interface PermissionMeta {
  id: string;
  label: string;
  description: string;
  category: string;
}

/** Ordered permission catalog, grouped by category (display order preserved). */
export const PERMISSION_CATALOG: PermissionMeta[] = [
  { id: 'pipelines:read', label: 'View pipelines', description: 'View pipelines and their executions', category: 'Pipelines' },
  { id: 'pipelines:write', label: 'Manage pipelines', description: 'Create, edit, and delete pipelines', category: 'Pipelines' },
  { id: 'pipelines:publish', label: 'Publish pipelines', description: 'Make pipelines public (org-wide/catalog visibility)', category: 'Pipelines' },
  { id: 'plugins:read', label: 'View plugins', description: 'View plugins and builds', category: 'Plugins' },
  { id: 'plugins:write', label: 'Manage plugins', description: 'Create, upload, edit, and delete plugins', category: 'Plugins' },
  { id: 'plugins:publish', label: 'Publish plugins', description: 'Make plugins public (org-wide/catalog visibility)', category: 'Plugins' },
  { id: 'compliance:read', label: 'View compliance', description: 'View compliance rules, policies, and scans', category: 'Compliance' },
  { id: 'compliance:write', label: 'Manage compliance', description: 'Create and edit rules, policies, and exemptions', category: 'Compliance' },
  { id: 'members:manage', label: 'Manage members', description: 'Add, remove, and change roles of org members', category: 'Members & Access' },
  { id: 'roles:manage', label: 'Manage roles', description: 'Create, edit, and delete roles', category: 'Members & Access' },
  { id: 'invitations:manage', label: 'Manage invitations', description: 'Send, resend, and revoke invitations', category: 'Members & Access' },
  { id: 'dashboards:read', label: 'View dashboards', description: 'View custom dashboards', category: 'Observability' },
  { id: 'dashboards:write', label: 'Manage dashboards', description: 'Create and edit custom dashboards', category: 'Observability' },
  { id: 'observability:read', label: 'View alerting', description: 'View alert rules and destinations', category: 'Observability' },
  { id: 'observability:write', label: 'Manage alerting', description: 'Create and edit alert rules and destinations', category: 'Observability' },
  { id: 'reports:read', label: 'View reports', description: 'View analytics and reports', category: 'Insights' },
  { id: 'reports:rollup', label: 'Roll up team reports', description: 'Include descendant teams when viewing reports', category: 'Insights' },
  { id: 'messages:read', label: 'View messages', description: 'View messages and announcements', category: 'Messaging' },
  { id: 'messages:write', label: 'Send messages', description: 'Send messages and announcements', category: 'Messaging' },
  { id: 'billing:read', label: 'View billing', description: 'View subscriptions and usage', category: 'Billing & Quotas' },
  { id: 'billing:manage', label: 'Manage billing', description: 'Manage subscriptions, add-ons, and the billing portal', category: 'Billing & Quotas' },
  { id: 'quotas:read', label: 'View quotas', description: 'View organization quotas and usage', category: 'Billing & Quotas' },
  { id: 'registry:read', label: 'View registry', description: 'View the container image registry', category: 'Registry' },
  { id: 'registry:write', label: 'Manage registry', description: 'Delete and copy container images', category: 'Registry' },
  { id: 'org:settings', label: 'Organization settings', description: 'Manage org settings (SSO/IdP, KMS, AI config)', category: 'Organization' },
];

/** Group a flat permission list into categories, preserving catalog order. */
function groupByCategory(perms: PermissionMeta[]): { category: string; permissions: PermissionMeta[] }[] {
  const order: string[] = [];
  const byCat = new Map<string, PermissionMeta[]>();
  for (const p of perms) {
    if (!byCat.has(p.category)) { byCat.set(p.category, []); order.push(p.category); }
    byCat.get(p.category)!.push(p);
  }
  return order.map((category) => ({ category, permissions: byCat.get(category)! }));
}

/**
 * Local mirror of api-core's `SUPERADMIN_ONLY_PERMISSIONS`
 * (`src/types/permissions.ts`). These gate the platform-operator image registry
 * and are NOT assignable through a user-authored custom Role — the backend
 * rejects them with `RL_PERMISSION_NOT_ASSIGNABLE` (400). Kept in sync via the
 * cross-package parity test (`permission-catalog-parity.test.ts`).
 */
export const SUPERADMIN_ONLY_PERMISSIONS: readonly string[] = [
  'registry:read',
  'registry:write',
];

const SUPERADMIN_ONLY_SET = new Set(SUPERADMIN_ONLY_PERMISSIONS);

/** Whether a permission may be granted through a user-authored custom Role. */
export function isOrgAssignablePermission(id: string): boolean {
  return !SUPERADMIN_ONLY_SET.has(id);
}

/**
 * Category → permissions for the custom-Role AUTHORING picker: the display
 * catalog filtered to org-assignable ids, with any now-empty category dropped
 * (so the "Registry" category disappears). Mirrors api-core's
 * `ORG_ASSIGNABLE_PERMISSIONS`.
 */
export const ORG_ASSIGNABLE_CATEGORIES: { category: string; permissions: PermissionMeta[] }[] =
  groupByCategory(PERMISSION_CATALOG.filter((p) => isOrgAssignablePermission(p.id)));

const LABELS = new Map(PERMISSION_CATALOG.map((p) => [p.id, p.label]));

/** Human label for a permission id (falls back to the raw id). */
export function permissionLabel(id: string): string {
  return LABELS.get(id) ?? id;
}

/**
 * The built-in Roles are now seeded (and existing docs migrated at boot) with
 * their canonical names — `Admin`, `Member`, `Super Admin` — so no remapping is
 * normally needed. This map is a defensive fallback that only rewrites the
 * pre-rename LEGACY names, in case a Role is read before the startup migration
 * has renamed it. Custom Roles pass through unchanged.
 */
const LEGACY_ROLE_NAMES: Record<string, string> = {
  Administrators: 'Admin',
  Developers: 'Member',
  Superadmins: 'Super Admin',
};

/** Display label for a Role name (canonical names pass through; legacy names softened). */
export function roleDisplayName(name: string): string {
  return LEGACY_ROLE_NAMES[name] ?? name;
}
