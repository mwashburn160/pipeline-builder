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

import { createLogger, isValidPermission } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { assertActorMayAssignRole, assertSystemOrgOnlyRoleInSystemOrg } from './role-authority.js';
import type { OrgId, RoleAssignmentActor, UserId } from './role-authority.js';
import { RL_REQUIRES_SUPERADMIN, RL_ROLE_NOT_FOUND } from './roles-errors.js';
import { toOrgId } from '../helpers/org-id.js';
import { Role, RoleAssignment } from '../models/index.js';
import type { RoleGrant } from '../models/index.js';

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
    .session(session ?? null).select('name grantsRole permissions').lean();
  const byRoleId = new Map(roles.map((r) => [String(r._id), {
    id: String(r._id),
    name: r.name,
    grantsRole: r.grantsRole as RoleGrant,
    permissions: ((r.permissions as string[]) ?? []).filter((p) => isValidPermission(p)),
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
      .session(session ?? null).select('grantsRole permissions').lean()
    : [];
  if (roles.length !== requested.length) throw new Error(RL_ROLE_NOT_FOUND);

  for (const role of roles) {
    if (role.grantsRole === 'superadmin' && !actor.isSuperAdmin) throw new Error(RL_REQUIRES_SUPERADMIN);
    assertActorMayAssignRole(role.permissions as string[] | undefined, actor);
    assertSystemOrgOnlyRoleInSystemOrg(role.permissions as string[] | undefined, oid);
  }

  // Removals are subject to the same ceiling (symmetry with removeUserFromRole):
  // a delegate must not be able to strip a capability they don't hold.
  const current = await serviceAccountRoles(oid, serviceAccountId, session);
  for (const role of current) {
    if (requested.includes(role.id)) continue;
    if (role.grantsRole === 'superadmin' && !actor.isSuperAdmin) throw new Error(RL_REQUIRES_SUPERADMIN);
    assertActorMayAssignRole(role.permissions, actor);
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
