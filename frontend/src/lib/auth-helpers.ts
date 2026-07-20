// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Runtime role/permission guards for the client-decoded user. `User` is a
// type-only import (erased at build time), so there's no runtime cycle with
// `@/types` re-exporting these back for back-compat.
import type { User } from '@/types';

/**
 * Check if user is a Pipeline Builder super-admin.
 *
 * Reads the `isSuperAdmin` flag from the JWT — the canonical signal for
 * operator authority. The legacy "user is admin/owner in the well-known
 * 'system' org" branch was removed alongside the backend cutover; flipping
 * a user to sysadmin now requires setting `User.isSuperAdmin=true`
 * (BOOTSTRAP_SUPERADMIN_EMAILS env or a future admin endpoint).
 */
// SECURITY: `user.isSuperAdmin` comes from the client-decoded (UNVERIFIED) JWT.
// Trust it ONLY for cosmetic UI gating (show/hide nav, redirect before render).
// Never treat it as an authorization decision — every privileged action is
// re-checked server-side against the token's verified claim, so a user who
// forges this flag sees admin UI but every API call still 403s.
export function isSystemAdmin(user: User | null): boolean {
  return user?.isSuperAdmin === true;
}

/**
 * Check if user is an organization admin — admin/owner role on a regular
 * customer org. Excludes sysadmins; the UI typically wants to render
 * "org admin" affordances separately from "Pipeline Builder operator"
 * affordances.
 */
export function isOrgAdmin(user: User | null): boolean {
  return (user?.role === 'admin' || user?.role === 'owner') && !isSystemAdmin(user);
}

/**
 * Whether the user holds a fine-grained permission in the active org (RBAC).
 * Superadmins implicitly hold all. UI-gating only — the server re-checks every
 * privileged action against the verified token (see the isSystemAdmin note).
 */
export function hasPermission(user: User | null, permission: string): boolean {
  return isSystemAdmin(user) || !!user?.permissions?.includes(permission);
}

/**
 * Whether a permission id denotes a MUTATION (a write) rather than a read.
 *
 * The catalog is coarse `resource:action` (see api-core `types/permissions.ts`):
 * `:read` are reads; `:write` and `:manage` (members/roles/invitations/billing)
 * are writes, and `org:settings` is a write surface too. Used to blanket-disable
 * write affordances during read-only impersonation, where the backend rejects
 * every non-GET request — so surfacing an enabled write control just produces a
 * 403 dead-end.
 */
export function isMutationPermission(permission: string): boolean {
  return /:(write|manage)$/.test(permission) || permission === 'org:settings';
}
