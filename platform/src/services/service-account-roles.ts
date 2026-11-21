// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-account Role assignment.
 *
 * A service account holds Roles through the SAME `role_assignments` collection
 * people use, so there is one Role model, one ceiling and one permission
 * resolver for both kinds of principal. Split out of `roles-service.ts` to keep
 * that deliberate sharing visible as its own surface rather than as a tail of
 * the human-facing file.
 */

import { createLogger, isValidPermission, SEED_BUNDLES, type RoleGrant, type SeedBundleId } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import {
  assertActorMayAssignRole,
  assertSystemOrgOnlyRoleInSystemOrg,
  effectiveRolePermissions,
  ROLE_PERMISSION_FIELDS,
} from './role-authority.js';
import type { OrgId, RoleAssignmentActor, UserId } from './role-authority.js';
import { RL_REQUIRES_SUPERADMIN, RL_ROLE_NOT_FOUND } from './roles-errors.js';
import { SA_BUILTIN_ROLE_MISSING } from './service-account-errors.js';
import { toOrgId } from '../helpers/org-id.js';
import { Role, RoleAssignment } from '../models/index.js';

const logger = createLogger('service-account-roles');

/**
 * The Roles a SERVICE ACCOUNT holds in an org, resolved through the SAME
 * `role_assignments` collection people use (see the model docs) — so there is
 * one Role model, one ceiling and one permission resolver for both kinds of
 * principal.
 */
export async function serviceAccountRoles(
  organizationId: OrgId,
  serviceAccountId: UserId,
  session?: mongoose.ClientSession,
): Promise<ServiceAccountRole[]> {
  const byAccount = await serviceAccountRolesFor(organizationId, [serviceAccountId], session);
  return byAccount.get(String(serviceAccountId)) ?? [];
}

/** One Role as the service-account surfaces report it. */
export interface ServiceAccountRole {
  id: string;
  name: string;
  grantsRole: RoleGrant;
  permissions: string[];
}

/**
 * The Roles held by SEVERAL service accounts, keyed by account id — two queries
 * regardless of how many accounts are asked for, so listing an org's accounts
 * costs a constant number of round-trips instead of one pair per account.
 * Accounts with no Roles are absent from the map.
 */
export async function serviceAccountRolesFor(
  organizationId: OrgId,
  serviceAccountIds: readonly UserId[],
  session?: mongoose.ClientSession,
): Promise<Map<string, ServiceAccountRole[]>> {
  const byAccount = new Map<string, ServiceAccountRole[]>();
  if (serviceAccountIds.length === 0) return byAccount;

  const assignments = await RoleAssignment.find({ serviceAccountId: { $in: serviceAccountIds }, organizationId })
    .session(session ?? null).select('serviceAccountId roleId').lean();
  if (assignments.length === 0) return byAccount;

  const roles = await Role.find({ _id: { $in: [...new Set(assignments.map((a) => String(a.roleId)))] } })
    .session(session ?? null).select(`name ${ROLE_PERMISSION_FIELDS}`).lean();
  const byRoleId = new Map(roles.map((role) => [String(role._id), {
    id: String(role._id),
    name: role.name,
    grantsRole: role.grantsRole as RoleGrant,
    permissions: effectiveRolePermissions(role).filter((p) => isValidPermission(p)),
  }]));

  for (const assignment of assignments) {
    const role = byRoleId.get(String(assignment.roleId));
    // A Role deleted between the two reads simply drops out — the account holds
    // whatever still exists, which is also what the exchange would resolve.
    if (!role) continue;
    const key = String(assignment.serviceAccountId);
    const held = byAccount.get(key) ?? [];
    held.push(role);
    byAccount.set(key, held);
  }
  return byAccount;
}

/**
 * REPLACE the Role set a service account holds (the UI edits it as a set, and a
 * replace is the only shape that can't leave a half-applied grant behind).
 *
 * Every ceiling that applies to assigning a Role to a PERSON applies here
 * identically, because a service account's authority is exactly its Roles:
 *   - the Role must belong to `orgId` (`RL_ROLE_NOT_FOUND`) — an account can
 *     never hold another tenant's Role;
 *   - a `superadmin`-granting Role needs the actor to BE a platform superadmin
 *     (`RL_REQUIRES_SUPERADMIN`), the same gate {@link addUserToRole} applies;
 *   - otherwise the actor must already hold every permission the Role grants
 *     (`RL_ASSIGN_EXCEEDS_CEILING`), so nobody can mint a machine credential
 *     more powerful than themselves. Checked against BOTH the incoming set and
 *     the set being removed, so a delegate can't strip a capability they lack.
 *
 * No `tokenVersion` bump is needed (a service account has no sessions): its
 * exchanged tokens live ~5 minutes and every exchange re-derives permissions
 * from these assignments, so a change takes effect within one token lifetime.
 */
export async function setServiceAccountRoles(
  orgId: string,
  serviceAccountId: string,
  roleIds: readonly string[],
  actor: RoleAssignmentActor,
  session?: mongoose.ClientSession,
): Promise<void> {
  const oid = toOrgId(orgId);
  const requested = [...new Set(roleIds)];

  const roles = requested.length > 0
    ? await Role.find({ _id: { $in: requested }, organizationId: oid })
      .session(session ?? null).select(ROLE_PERMISSION_FIELDS).lean()
    : [];
  if (roles.length !== requested.length) throw new Error(RL_ROLE_NOT_FOUND);

  for (const role of roles) {
    if (role.grantsRole === 'superadmin' && !actor.isSuperAdmin) throw new Error(RL_REQUIRES_SUPERADMIN);
    const granted = effectiveRolePermissions(role);
    assertActorMayAssignRole(granted, actor);
    assertSystemOrgOnlyRoleInSystemOrg(granted, oid);
  }

  // Removals are subject to the same ceiling (symmetry with removeUserFromRole):
  // a delegate must not be able to strip a capability they don't hold.
  const current = await serviceAccountRoles(oid, serviceAccountId, session);
  // (`held` entries are already resolved — `serviceAccountRolesFor` ran each
  // Role through `effectiveRolePermissions`.)
  for (const held of current) {
    if (requested.includes(held.id)) continue;
    if (held.grantsRole === 'superadmin' && !actor.isSuperAdmin) throw new Error(RL_REQUIRES_SUPERADMIN);
    assertActorMayAssignRole(held.permissions, actor);
  }

  await RoleAssignment.deleteMany({ serviceAccountId, organizationId: oid }, { session });
  if (requested.length > 0) {
    await RoleAssignment.insertMany(
      requested.map((roleId) => ({ serviceAccountId, roleId, organizationId: oid })),
      { session, ordered: true },
    );
  }
  logger.info('Set service-account Roles', { organizationId: orgId, serviceAccountId, roles: requested.length });
}

/** Drop every Role assignment of a service account (delete / org cascade). */
export async function clearServiceAccountRoles(
  serviceAccountId: UserId | UserId[],
  session?: mongoose.ClientSession,
): Promise<void> {
  const filter = Array.isArray(serviceAccountId)
    ? { serviceAccountId: { $in: serviceAccountId } }
    : { serviceAccountId };
  await RoleAssignment.deleteMany(filter, { session });
}

/**
 * The org's built-in (`system`) Role for a seed bundle — e.g. `Pipeline
 * Automation` — located by the name api-core's `SEED_BUNDLES` gives it, exactly
 * as `pipeline-manager` resolved it client-side. Throws
 * `SA_BUILTIN_ROLE_MISSING` when the org has none (seeded at creation, so only
 * a Role removed outside the API).
 * Resolving it grants nothing: the assignment still goes through the creator's
 * ceiling in `createServiceAccount`.
 */
export async function resolveBuiltinRoleId(orgId: string, bundle: SeedBundleId): Promise<string> {
  const role = await Role.findOne({ organizationId: toOrgId(orgId), system: true, name: SEED_BUNDLES[bundle].name })
    .select('_id').lean();
  if (!role) throw new Error(SA_BUILTIN_ROLE_MISSING);
  return String(role._id);
}
