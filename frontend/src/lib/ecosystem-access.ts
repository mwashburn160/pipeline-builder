// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may see the plugin-ecosystem console.
 *
 * Only the SYSTEM org manages or approves anything in the ecosystem, and only
 * its Ecosystem Managers (holders of `plugins:moderate` / `publishers:verify`)
 * and superadmins act for it. Both halves are required: a tenant user can never
 * hold those permissions (system-org-only — no Role authored in a tenant may
 * carry one), and a superadmin who has switched INTO a tenant org is acting as
 * that tenant, so the console disappears for them too until they switch back.
 */

import { SEED_BUNDLES } from '@pipeline-builder/api-core/permissions';
import type { Permission } from '@pipeline-builder/api-core/permissions';
import { SYSTEM_ORG_ID } from './constants';
import type { User } from '@/types';

/** Either permission opens the console (superadmins hold every permission). */
export const ECOSYSTEM_CONSOLE_PERMISSIONS = ['plugins:moderate', 'publishers:verify'] as const;

/**
 * The system org's built-in Role (seeded by `seedDefaultRoles`, `system: true`).
 *
 * From api-core's `SEED_BUNDLES` — the SAME table the seeder reads — because
 * this was a THIRD hand-written copy of the name, after the platform's own
 * constant and the staffing roster's list. The name is the handle the roster
 * looks a Role up by (ids are per-install), so a rename that missed one copy
 * rendered "Role not found" and the Role's only grant path vanished, with every
 * suite still green.
 */
export const ECOSYSTEM_MANAGER_ROLE_NAME = SEED_BUNDLES.ecosystem_manager.name;

/**
 * The system org's OTHER ecosystem Role: the publisher-verification half, split
 * out of Ecosystem Manager so triaging the publish queue no longer carries the
 * ability to award Verified status. Same handle-by-name rule as above.
 */
export const PUBLISHER_VERIFIER_ROLE_NAME = SEED_BUNDLES.publisher_verifier.name;

/** Is the viewer's ACTIVE org the system org? */
export function isSystemOrgActive(user: Pick<User, 'organizationId'> | null | undefined): boolean {
  return !!user?.organizationId && user.organizationId.toLowerCase() === SYSTEM_ORG_ID;
}

/** System org AND one of the ecosystem permissions. */
export function canSeeEcosystemConsole(
  user: Pick<User, 'organizationId'> | null | undefined,
  can: (permission: Permission) => boolean,
): boolean {
  return isSystemOrgActive(user) && ECOSYSTEM_CONSOLE_PERMISSIONS.some((p) => can(p));
}
