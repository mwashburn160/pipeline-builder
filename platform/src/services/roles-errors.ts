// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Role and role-assignment error codes.
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers and
 * tests import the codes without loading a service and its models/config.
 */

export const RL_ROLE_NOT_FOUND = 'RL_ROLE_NOT_FOUND';
export const RL_USER_NOT_FOUND = 'RL_USER_NOT_FOUND';
export const RL_NOT_ORG_MEMBER = 'RL_NOT_ORG_MEMBER';
/** You can't remove yourself from a Role that grants your own admin/superadmin. */
export const RL_CANNOT_REMOVE_SELF = 'RL_CANNOT_REMOVE_SELF';
/** Removing this user would leave a privilege-granting Role with no members. */
export const RL_LAST_PRIVILEGED_MEMBER = 'RL_LAST_PRIVILEGED_MEMBER';
/** Only a platform superadmin may add/remove members of a `superadmin`-granting
 *  Role — otherwise a mere org admin of the system org could mint or strip
 *  platform superadmins via `recomputeUserOrgRole`. */
export const RL_REQUIRES_SUPERADMIN = 'RL_REQUIRES_SUPERADMIN';
/** Seeded (`system`) Roles can't be renamed/edited/deleted via the CRUD API. */
export const RL_SYSTEM_IMMUTABLE = 'RL_SYSTEM_IMMUTABLE';
/** Another Role in the org already uses this name. */
export const RL_NAME_TAKEN = 'RL_NAME_TAKEN';
/** A supplied permission string isn't in the api-core catalog. */
export const RL_INVALID_PERMISSION = 'RL_INVALID_PERMISSION';
/** A supplied permission is valid but NOT assignable through a user-authored
 *  custom Role — it's superadmin-only (the shared image registry:
 *  `registry:read`/`registry:write`) or system-org-only (the plugin ecosystem's
 *  `plugins:moderate`/`publishers:verify`). Built-in Role seeds are exempt (they carry
 *  it legitimately); this guards only custom-Role create/update. */
export const RL_PERMISSION_NOT_ASSIGNABLE = 'RL_PERMISSION_NOT_ASSIGNABLE';
/** A requested permission is org-assignable but the ACTOR authoring the custom
 *  Role does not themselves hold it — a custom Role can't grant beyond the
 *  creator's own permission ceiling (prevents a delegated `roles:manage` holder
 *  from minting + self-assigning `members:manage`/`org:settings`/etc.).
 *  Platform superadmins bypass the ceiling (they implicitly hold everything). */
export const RL_PERMISSION_EXCEEDS_CEILING = 'RL_PERMISSION_EXCEEDS_CEILING';
/** The system org has no seeded Super Admin Role — platform-admin can't be
 *  granted/revoked via Role assignment (should never happen post-seed). */
export const RL_SUPERADMIN_ROLE_MISSING = 'RL_SUPERADMIN_ROLE_MISSING';
/** The actor tried to ASSIGN (or unassign) a Role granting permissions beyond
 *  their own effective set — the assignment-time analogue of the create/update
 *  ceiling (`RL_PERMISSION_EXCEEDS_CEILING`). Without this, a non-admin holder
 *  of a delegated `roles:manage` custom Role could assign the built-in Admin
 *  Role (the full `ADMIN_PERMISSIONS` bundle) — or any Role carrying a
 *  capability they lack — to themselves and self-escalate past the very ceiling
 *  `sanitizePermissions` enforces on custom-Role authoring. Admin/owner of the
 *  org and platform superadmins bypass (they already hold the full bundle). */
export const RL_ASSIGN_EXCEEDS_CEILING = 'RL_ASSIGN_EXCEEDS_CEILING';
/** Only a platform superadmin may assign, unassign, edit or delete a Role
 *  carrying a SYSTEM-ORG-ONLY permission (`plugins:moderate`,
 *  `publishers:verify` — the system org's "Ecosystem Manager" Role). An org
 *  admin of the system org is refused too: ecosystem governance is a platform
 *  decision, not in-org delegation (docs/permissions.md). */
export const RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN = 'RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN';
/** A Role carrying a system-org-only permission can only be held inside the
 *  system org — refused when the target org is any other org. */
export const RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG = 'RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG';
