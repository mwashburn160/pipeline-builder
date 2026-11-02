// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Runtime role/permission guards for the client-decoded user.
import type { User } from '@/types';

/**
 * Check if user is a Pipeline Builder super-admin.
 *
 * Reads the `isSuperAdmin` flag from the JWT — the canonical signal for
 * operator authority — being an admin/owner of the 'system' org is not.
 * A user becomes a sysadmin through `User.isSuperAdmin=true`
 * (BOOTSTRAP_SUPERADMIN_EMAILS).
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
 * The catalog is `resource:action` with a CLOSED verb vocabulary (see api-core
 * `types/permissions.ts`), and this function is the main reason it is closed:
 * `:read` and `:rollup` (a read-visibility scope) are reads, and `:write`,
 * `:manage`, `:publish` and `:open` are writes. Used to blanket-disable write
 * affordances during read-only impersonation, where the backend rejects every
 * non-GET request — so surfacing an enabled write control would just produce a
 * 403 dead-end.
 *
 * `:open` is in the suffix list because reaching an operator console is a GET,
 * so the read-only gate cannot stop it, the cookie it mints is a platform
 * credential, and pgAdmin, mongo-express and the RustFS console are shells that
 * WRITE.
 *
 * The set below is the REMAINDER: five domain verbs with no synonym in the
 * vocabulary, each of which would otherwise be misread as a read. (`:purge` and
 * `:approve` are NOT in it — both are self-classifying, so they ride the suffix
 * pattern above.)
 *
 *  - `logs:export`      — a GET, so the non-GET gate misses it. Bulk-downloading
 *    the viewed org's logs is exactly the egress read-only impersonation exists
 *    to prevent. The backend refuses it too (log-controller's export handler);
 *    this is the affordance, not the gate.
 *  - `plugins:install`, `plugins:moderate`, `publishers:verify` — ecosystem
 *    ACTIONS (install/upgrade, approve, reject, yank, verify).
 *  - `billing:operate`  — creates, applies and revokes discount tokens and
 *    activates promotion campaigns. It MOVES MONEY for organisations the holder
 *    is not a member of.
 */
const ORG_CONFIG_MUTATIONS = new Set([
  'logs:export',
  'plugins:install', 'plugins:moderate', 'publishers:verify',
  'billing:operate',
]);
export function isMutationPermission(permission: string): boolean {
  return /:(write|manage|publish|open|purge|approve)$/.test(permission) || ORG_CONFIG_MUTATIONS.has(permission);
}
