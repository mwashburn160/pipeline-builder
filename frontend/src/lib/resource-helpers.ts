// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for pipeline and plugin resource pages.
 * Centralizes common filter-to-API parameter mapping and permission checks.
 */
import type { Permission } from '@pipeline-builder/api-core/permissions';

/**
 * Maps common filter keys (visibility, status, default) to API parameter names.
 * Backend's AccessControlQueryBuilder handles tenant scoping; this only
 * forwards the user's filter selections.
 */
export function mapCommonParams(params: Record<string, string>): Record<string, string> {
  const p: Record<string, string> = {};
  if (params.visibility) p.visibility = params.visibility;
  if (params.status) p.isActive = params.status === 'active' ? 'true' : 'false';
  if (params.default) p.isDefault = params.default === 'default' ? 'true' : 'false';
  return p;
}

/** The slice of a catalog row the visibility gate reads. */
export interface VisibilityTarget {
  visibility?: string;
  /** Author — owns the `private` rung. */
  createdBy?: string;
  /** Owning org. A row from another org (the system catalog, a parent org) is read-only here. */
  orgId?: string;
}

/**
 * Whether the current user may edit/delete a catalog row, per its visibility
 * rung. Mirrors the backend's `requireVisibilityWriteAccess` exactly so the UI
 * never shows an affordance the API would refuse:
 *
 * - `public`  — super admins, or holders of the resource's `:publish`
 * - `org`     — anyone (the caller's `:write` permission is checked separately)
 * - `private` — the AUTHOR alone (plus super admins)
 *
 * A row another org owns is never writable from here (super admins aside): every
 * write route looks the row up scoped to the caller's org and answers not-found,
 * so offering Edit/Delete on a system-catalog or parent-org row only fails.
 */
export function canModify(
  resource: VisibilityTarget,
  opts: { isSuperAdmin: boolean; canPublish: boolean; userId?: string; orgId?: string },
): boolean {
  if (opts.isSuperAdmin) return true;
  if (resource.orgId && opts.orgId && resource.orgId.toLowerCase() !== opts.orgId.toLowerCase()) return false;
  if (resource.visibility === 'public') return opts.canPublish;
  // Fail closed without a viewer — an absent userId must not match an absent author.
  if (resource.visibility === 'private') return !!opts.userId && resource.createdBy === opts.userId;
  return true;
}

/**
 * Whether the current user may perform a write (run/stop/edit/delete) on a
 * pipeline. Requires BOTH the fine-grained `pipelines:write` capability AND
 * the visibility gate (`canModify`). Centralizing this keeps the list and
 * detail pages from diverging — the backend gates every pipeline mutation on
 * `pipelines:write`, so a read-only member must not see enabled write controls.
 *
 * @param can - Permission checker from `useAuthGuard` (`can('pipelines:write')`).
 * @param isSuperAdmin - Whether the user is a system admin.
 * @param resource - The pipeline's visibility rung + author.
 * @param userId - The caller's user id, for the author-only `private` rung.
 * @param orgId - The caller's org; a pipeline another org owns is read-only.
 */
export function canWritePipeline(
  can: (permission: Permission) => boolean,
  isSuperAdmin: boolean,
  resource: VisibilityTarget,
  userId?: string,
  orgId?: string,
): boolean {
  return can('pipelines:write')
    && canModify(resource, { isSuperAdmin, canPublish: can('pipelines:publish'), userId, orgId });
}
