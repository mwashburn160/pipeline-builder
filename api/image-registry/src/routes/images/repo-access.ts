// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { inLibraryNamespace, inPublicNamespace, inQuarantineNamespace, inRegistryMetaNamespace, inSystemNamespace, repoTenant } from '../../services/namespaces.js';

/**
 * Per-repo, org-ownership authorization for the `/api/images` management
 * surface — a SECOND, independent gate that runs AFTER the `registry:read` /
 * `registry:write` permission gates.
 *
 * The permission gates answer "may this caller use the images API at all?"
 * (today `registry:*` are superadmin-only placeholders). They do NOT answer
 * "may this caller touch THIS repo?" — so if `registry:read`/`write` is ever
 * wired to an org-assignable role, an org admin holding it could read or
 * poison ANOTHER tenant's repos (and the copy route reads/writes arbitrary
 * source/target repos). These checks close that gap by binding every repo
 * operation to the caller's own org, mirroring the `/token` scope authorizer
 * (`token-service.ts authorizeScope`):
 *
 *   - a superadmin may touch any repo;
 *   - `org-{id}/*` is owned by org `{id}` — read+write for that org only;
 *   - `system/*` and `library/*` are pull-open to any authenticated caller;
 *     writing them is superadmin-only, except the system org may write
 *     `system/*` (it owns that namespace, as in the token authorizer);
 *   - `public/*` (listed plugin versions) is pull-open
 *     and APPEND-ONLY: nobody writes it through this API, superadmins included —
 *     only the internal publish/yank/gc routes do, as the management identity;
 *   - `registry-meta/*` (this service's bookkeeping) is closed to everyone;
 *   - `quarantine/*` (anonymous plugin submissions awaiting moderation, plugin
 *     ecosystem) is closed to everyone here — never listed, read or written
 *     through this API, superadmins included. Only the plugin service principal
 *     touches it, over the registry token flow and the internal routes;
 *   - any other/unrecognized namespace is superadmin-only.
 *
 * They are enforced regardless of who holds the permission, so the tenant
 * boundary can't be widened by a future permission-wiring change.
 */
export interface RepoAccessUser {
  organizationId?: string;
  isSuperAdmin?: boolean;
}

function ownsTenant(user: RepoAccessUser | undefined, tenant: string): boolean {
  return !!user?.organizationId && user.organizationId.toLowerCase() === tenant;
}

/** Namespaces no user may write through the images API — superadmins included. */
function isAppendOnlyOrClosed(repo: string): boolean {
  return inPublicNamespace(repo) || inRegistryMetaNamespace(repo) || inQuarantineNamespace(repo);
}

/** True when `user` may READ (list/pull/inspect) `repo`. */
export function canReadRepo(user: RepoAccessUser | undefined, repo: string): boolean {
  if (inRegistryMetaNamespace(repo) || inQuarantineNamespace(repo)) return false;
  if (inPublicNamespace(repo)) return !!user;
  if (user?.isSuperAdmin) return true;
  const tenant = repoTenant(repo);
  if (tenant !== null) return ownsTenant(user, tenant);
  // system/* and library/* base images are pull-open to any authenticated caller
  // (mirrors the token authorizer's "anyone can pull system/library" rule).
  if (inSystemNamespace(repo) || inLibraryNamespace(repo)) return true;
  // Unrecognized namespace → superadmin-only (deny by default).
  return false;
}

/** True when `user` may WRITE (push/delete/copy-target) `repo`. */
export function canWriteRepo(user: RepoAccessUser | undefined, repo: string): boolean {
  if (isAppendOnlyOrClosed(repo)) return false;
  if (user?.isSuperAdmin) return true;
  const tenant = repoTenant(repo);
  if (tenant !== null) return ownsTenant(user, tenant);
  // The system org owns system/* and may write there; everything else in the
  // shared/unrecognized space is superadmin-only.
  if (inSystemNamespace(repo)) return user?.organizationId === SYSTEM_ORG_ID;
  return false;
}
