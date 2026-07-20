// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for pipeline and plugin resource pages.
 * Centralizes common filter-to-API parameter mapping and permission checks.
 */

/**
 * Maps common filter keys (access, status, default) to API parameter names.
 * Backend's AccessControlQueryBuilder handles tenant scoping; this only
 * forwards the user's filter selections.
 */
export function mapCommonParams(params: Record<string, string>): Record<string, string> {
  const p: Record<string, string> = {};
  if (params.access) p.accessModifier = params.access;
  if (params.status) p.isActive = params.status === 'active' ? 'true' : 'false';
  if (params.default) p.isDefault = params.default === 'default' ? 'true' : 'false';
  return p;
}

/** Whether the current user can edit/delete a resource based on access modifier. */
export function canModify(isSuperAdmin: boolean, accessModifier: string): boolean {
  return isSuperAdmin || accessModifier === 'private';
}

/**
 * Whether the current user may perform a write (run/stop/edit/delete) on a
 * pipeline. Requires BOTH the fine-grained `pipelines:write` capability AND
 * ownership of the resource (`canModify`). Centralizing this keeps the list and
 * detail pages from diverging — the backend gates every pipeline mutation on
 * `pipelines:write`, so a read-only member must not see enabled write controls.
 *
 * @param can - Permission checker from `useAuthGuard` (`can('pipelines:write')`).
 * @param isSuperAdmin - Whether the user is a system admin.
 * @param accessModifier - The pipeline's access modifier ('public' | 'private').
 */
export function canWritePipeline(
  can: (permission: string) => boolean,
  isSuperAdmin: boolean,
  accessModifier: string,
): boolean {
  return can('pipelines:write') && canModify(isSuperAdmin, accessModifier);
}
