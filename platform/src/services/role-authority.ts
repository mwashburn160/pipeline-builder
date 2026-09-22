// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The RBAC authority model: what a Role's grant confers, and the CEILING that
 * stops an actor handing out more than they hold.
 *
 * Split out of `roles-service.ts` because three separate surfaces enforce the
 * same two ceilings — custom-Role authoring (`role-crud.ts`), built-in Admin
 * assignment (`roles-service.ts`) and service-account Role assignment
 * (`service-account-roles.ts`) — and a ceiling that lives in only one of them
 * is a ceiling the other two can walk around.
 */

import {
  ECOSYSTEM_MANAGER_PERMISSIONS,
  isOrgAssignablePermission,
  isSystemOrgId,
  isSystemOrgOnlyPermission,
  isValidPermission,
  ROLE_PERMISSIONS,
} from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import {
  RL_ASSIGN_EXCEEDS_CEILING,
  RL_INVALID_PERMISSION,
  RL_PERMISSION_EXCEEDS_CEILING,
  RL_PERMISSION_NOT_ASSIGNABLE,
  RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG,
  RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN,
} from './roles-errors.js';
import type { RoleGrant, RoleSeedBundle } from '../models/index.js';

/** An org id in either of the two forms Mongoose accepts. */
export type OrgId = string | mongoose.Types.ObjectId;
/** A user (or service-account) id in either of the two forms Mongoose accepts. */
export type UserId = string | mongoose.Types.ObjectId;

/** The built-in Role's own `permissions[]` bundle for a coarse `grantsRole`.
 *  Single-source model: a built-in Role carries its permissions EXPLICITLY
 *  (seeded from api-core `ROLE_PERMISSIONS`), so it is self-describing and the
 *  runtime resolver reads only the Role's own list. `superadmin` and `owner`
 *  both map to the full `admin` bundle. */
export function permissionsForGrantsRole(role: RoleGrant): string[] {
  return role === 'member' ? [...ROLE_PERMISSIONS.member] : [...ROLE_PERMISSIONS.admin];
}

/**
 * The permission bundle a BUILT-IN Role carries. A Role with a `seedBundle`
 * (today only the system org's "Ecosystem Manager") carries that named bundle;
 * every other built-in Role carries the bundle for its `grantsRole`. Used by the
 * seeder and the startup re-sync so neither can flatten the Ecosystem Manager's
 * bundle into the plain Member bundle it shares a `grantsRole` with.
 */
export function builtinRolePermissions(role: { grantsRole: RoleGrant; seedBundle?: RoleSeedBundle | null }): string[] {
  if (role.seedBundle === 'ecosystem_manager') return [...ECOSYSTEM_MANAGER_PERMISSIONS];
  return permissionsForGrantsRole(role.grantsRole);
}

/** Whether a Role's permission list carries any system-org-only permission
 *  (`plugins:moderate`, `publishers:verify` — see api-core
 *  `SYSTEM_ORG_ONLY_PERMISSIONS`). */
export function carriesSystemOrgOnlyPermission(rolePermissions: readonly string[] | undefined): boolean {
  return (rolePermissions ?? []).some((p) => isSystemOrgOnlyPermission(p));
}

/**
 * Target-side guard for a Role carrying a system-org-only permission: such a
 * Role may be held only inside the system org (docs/plans/plugin-ecosystem.md
 * §5a). The seeder only creates one there and custom Roles can never carry the
 * permissions, so this is defence in depth against a hand-written document.
 * Throws `RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG`.
 */
export function assertSystemOrgOnlyRoleInSystemOrg(rolePermissions: readonly string[] | undefined, orgId: OrgId): void {
  if (carriesSystemOrgOnlyPermission(rolePermissions) && !isSystemOrgId(String(orgId))) {
    throw new Error(RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG);
  }
}

/**
 * The permission ceiling an actor is allowed to grant through a custom Role:
 * the actor's own resolved permissions, plus their platform-superadmin status
 * (which lifts the ceiling to everything org-assignable).
 */
export interface ActorPermissionCeiling {
  /** The actor's resolved fine-grained permissions in their active org (the JWT
   *  `permissions` claim). A superadmin may carry none and still bypass. */
  permissions: readonly string[];
  /** Platform superadmin — bypasses the ceiling entirely. */
  isSuperAdmin: boolean;
}

/**
 * Validate + normalize a permission list for a user-authored CUSTOM Role.
 *
 * Three gates: (1) every entry must be a known api-core permission
 * (`RL_INVALID_PERMISSION`); (2) it must be ORG-ASSIGNABLE — the superadmin-only
 * registry permissions (`registry:read`/`registry:write`) and the
 * system-org-only ecosystem permissions (`plugins:moderate`/`publishers:verify`)
 * are REJECTED (`RL_PERMISSION_NOT_ASSIGNABLE`) in EVERY org, the system org
 * and superadmin actors included, so no custom Role can ever carry a
 * platform-operator or ecosystem-governance capability; and (3) it must be within the ACTOR's own
 * permission ceiling — a non-superadmin can only grant permissions they
 * themselves hold (`RL_PERMISSION_EXCEEDS_CEILING`), so a delegated
 * `roles:manage` holder can't mint + self-assign privileges they lack (e.g.
 * `members:manage`). Superadmins bypass gate (3). Built-in Role seeds bypass all
 * of this (they're created directly from `ROLE_PERMISSIONS`, never through here).
 */
export function sanitizePermissions(permissions: unknown, actor: ActorPermissionCeiling): string[] {
  if (!Array.isArray(permissions)) return [];
  const ceiling = new Set(actor.permissions);
  const out = new Set<string>();
  for (const p of permissions) {
    if (typeof p !== 'string' || !isValidPermission(p)) throw new Error(RL_INVALID_PERMISSION);
    if (!isOrgAssignablePermission(p)) throw new Error(RL_PERMISSION_NOT_ASSIGNABLE);
    if (!actor.isSuperAdmin && !ceiling.has(p)) throw new Error(RL_PERMISSION_EXCEEDS_CEILING);
    out.add(p);
  }
  return [...out];
}

/**
 * The actor context for a Role ASSIGNMENT change (add/remove member).
 *
 * Role assignment must enforce the same permission ceiling that
 * {@link sanitizePermissions} enforces on custom-Role CREATE/UPDATE — otherwise
 * a mere `roles:manage` delegate could grant a capability they don't hold by
 * ASSIGNING a Role that carries it (e.g. the built-in Admin Role), bypassing the
 * authoring ceiling entirely.
 */
export interface RoleAssignmentActor {
  /** Platform superadmin — bypasses every ceiling (implicitly holds all). */
  isSuperAdmin: boolean;
  /** The actor is an admin/owner of the target org (coarse authority). Admins
   *  already hold the full `ADMIN_PERMISSIONS` bundle, so they may assign any
   *  org-assignable Role; this bypasses the fine-grained superset check below. */
  isOrgAdmin: boolean;
  /** The actor's resolved fine-grained permissions in their active org (the JWT
   *  `permissions` claim; see `resolveUserPermissions`). This is the ceiling for
   *  a non-admin delegate: they may only assign a Role whose granted permissions
   *  are ALL within this set. */
  permissions: readonly string[];
}

/**
 * Assignment-time permission ceiling: assert `actor` is allowed to add/remove
 * members of a Role granting `rolePermissions`.
 *
 * Mirrors the create/update ceiling: a platform superadmin or an org admin/owner
 * may assign ANY Role; a delegated non-admin actor (holding e.g. only
 * `roles:manage`) may assign a Role ONLY if their own effective permission set
 * is a SUPERSET of the Role's granted permissions — you can't grant (or strip,
 * for symmetry) a capability you don't hold yourself. Throws
 * `RL_ASSIGN_EXCEEDS_CEILING` otherwise. Note the `superadmin`-granting-Role gate
 * is separate and stricter (only a platform superadmin, checked by the callers).
 *
 * A Role carrying a SYSTEM-ORG-ONLY permission (the system org's "Ecosystem
 * Manager") is stricter still: only a platform superadmin may assign, unassign,
 * edit or delete it — an org admin of the system org included is refused
 * (`RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN`). Checked BEFORE the org-admin
 * bypass, so every caller of this ceiling inherits it.
 */
export function assertActorMayAssignRole(rolePermissions: readonly string[] | undefined, actor: RoleAssignmentActor): void {
  if (carriesSystemOrgOnlyPermission(rolePermissions) && !actor.isSuperAdmin) {
    throw new Error(RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN);
  }
  if (actor.isSuperAdmin || actor.isOrgAdmin) return;
  const held = new Set(actor.permissions);
  for (const p of rolePermissions ?? []) {
    if (!held.has(p)) throw new Error(RL_ASSIGN_EXCEEDS_CEILING);
  }
}
