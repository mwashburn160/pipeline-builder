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
export function canModify(isSysAdmin: boolean, accessModifier: string): boolean {
  return isSysAdmin || accessModifier === 'private';
}
