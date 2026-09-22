// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may see the plugin-ecosystem console.
 *
 * Only the SYSTEM org manages or approves anything in the ecosystem, and only
 * its Ecosystem Managers (holders of `plugins:moderate` / `publishers:verify`)
 * and superadmins act for it. Both halves are required: a tenant user can never
 * hold those permissions (they're system-org-only and non-assignable), and a
 * superadmin who has switched INTO a tenant org is acting as that tenant, so the
 * console disappears for them too until they switch back.
 */

import { SYSTEM_ORG_ID } from './constants';
import type { User } from '@/types';

/** Either permission opens the console (superadmins hold every permission). */
export const ECOSYSTEM_CONSOLE_PERMISSIONS = ['plugins:moderate', 'publishers:verify'] as const;

/** The system org's built-in role (seeded by `seedDefaultRoles`, `system: true`). */
export const ECOSYSTEM_MANAGER_ROLE_NAME = 'Ecosystem Manager';

/** Is the viewer's ACTIVE org the system org? */
export function isSystemOrgActive(user: Pick<User, 'organizationId'> | null | undefined): boolean {
  return !!user?.organizationId && user.organizationId.toLowerCase() === SYSTEM_ORG_ID;
}

/** System org AND one of the ecosystem permissions. */
export function canSeeEcosystemConsole(
  user: Pick<User, 'organizationId'> | null | undefined,
  can: (permission: string) => boolean,
): boolean {
  return isSystemOrgActive(user) && ECOSYSTEM_CONSOLE_PERMISSIONS.some((p) => can(p));
}
