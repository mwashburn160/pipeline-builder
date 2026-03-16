/**
 * Shared helpers for pipeline and plugin resource pages.
 * Centralizes common filter-to-API parameter mapping and permission checks.
 */

/** Maps common filter keys (access, status, default) to API parameter names. */
export function mapCommonParams(params: Record<string, string>, canViewPublic: boolean): Record<string, string> {
  const p: Record<string, string> = {};
  if (params.access) p.accessModifier = params.access;
  else if (!canViewPublic) p.accessModifier = 'private';
  if (params.status) p.isActive = params.status === 'active' ? 'true' : 'false';
  if (params.default) p.isDefault = params.default === 'default' ? 'true' : 'false';
  return p;
}

/** Whether the current user can edit/delete a resource based on access modifier. */
export function canModify(isSysAdmin: boolean, accessModifier: string): boolean {
  return isSysAdmin || accessModifier === 'private';
}
