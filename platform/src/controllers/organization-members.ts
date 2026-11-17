// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, ErrorCode, paginationMeta, sendError, sendSuccess, isServicePrincipal, getParam, isSystemAdmin } from '@pipeline-builder/api-core';
import { isOrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import { audit } from '../helpers/audit.js';
import { canAccessOrg, ensureAuthenticated, forbid, getAdminContext, requireOrgScope, withController, roleAssignmentActor } from '../helpers/controller-helper.js';
import { listPage } from '../helpers/pagination.js';
import { orgMembersService } from '../services/index.js';
import { OM_ORG_NOT_FOUND, OM_USER_NOT_FOUND, OM_ALREADY_MEMBER, OM_NOT_A_MEMBER, OM_CANNOT_REMOVE_OWNER, OM_OWNER_MEMBERSHIP_NOT_FOUND, OM_NEW_OWNER_MUST_BE_MEMBER, OM_ALREADY_OWNER, OM_MEMBERSHIP_NOT_FOUND, OM_ALREADY_INACTIVE, OM_ALREADY_ACTIVE, OM_TARGETS_OUT_OF_SCOPE, OM_SEAT_LIMIT, OM_CONSENT_REQUIRED } from '../services/org-members-errors.js';
import { pauseFormerMemberReports } from '../services/report-ownership.js';
import { RL_ASSIGN_EXCEEDS_CEILING, RL_LAST_PRIVILEGED_MEMBER, RL_REQUIRES_SUPERADMIN, RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN } from '../services/roles-errors.js';
import {
  validateBody,
  addMemberSchema,
  bulkAddMemberSchema,
  transferOwnershipSchema,
} from '../utils/validation.js';

const logger = createLogger('organization-members-controller');

/** A direct add the person never agreed to: the UI routes the admin to an
 *  invitation (the same way it handles "no account for that address"). */
const CONSENT_REQUIRED = {
  status: 409,
  message: 'That person is not in your organization yet. Send them an invitation — they join when they accept.',
  code: 'MEMBER_INVITATION_REQUIRED',
};

/** Ending a membership takes away every Role the person holds in the org, so it
 *  answers the same refusals as removing them from a Role. */
const STRIP_ROLE_REFUSALS = {
  [RL_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can remove or deactivate a member of a superadmin role' },
  [RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can remove or deactivate a member of an ecosystem-management role' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot remove or deactivate this member: they hold a role granting permissions you do not hold yourself' },
  [RL_LAST_PRIVILEGED_MEMBER]: { status: 400, message: 'Cannot remove or deactivate the last member of an admin role — the organization would be left with no one in it. Add another member to that role first.' },
};

/** The Role-assignment ceiling context for an add that grants the Admin Role. */
/** GET /organization/:id/members */
export const getOrganizationMembers = withController('Get members', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  // Own org (any member), a team you manage (parent-org admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return forbid(req, res, 'org-access', 'Forbidden: Can only view members of your organization');
  }

  // Bound the roster: parse limit/offset + optional search/role, and push them
  // into the DB query (service-side, never in-memory) so a large org doesn't
  // ship its whole membership. Mirrors the paginated list endpoints' shape.
  const { offset, limit } = listPage(req.query);
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const roleRaw = typeof req.query.role === 'string' ? req.query.role : undefined;
  const role = isOrgRole(roleRaw) ? roleRaw : undefined;
  // Active/inactive status filter: map the `active|inactive` query value to the
  // membership `isActive` flag; anything else leaves the filter off.
  const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
  const isActive = statusRaw === 'active' ? true : statusRaw === 'inactive' ? false : undefined;
  // Server-side sort — the service whitelists `sortBy`, so an unknown field is
  // harmless (falls back to the default join-time order).
  const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : undefined;
  const sortOrder = req.query.sortOrder === 'desc' ? 'desc' : req.query.sortOrder === 'asc' ? 'asc' : undefined;

  const result = await orgMembersService.listMembers(id, { offset, limit, search, role, isActive, sortBy, sortOrder });
  if (!result) return sendError(res, 404, 'Organization not found');

  const { members, total, offset: off, limit: lim, organizationId, organizationName, ownerId } = result;
  sendSuccess(res, 200, {
    organizationId,
    organizationName,
    ownerId,
    members,
    pagination: paginationMeta({ total, offset: off, limit: lim }),
  });
});

/**
 * GET /organization/:id/members/:userId/exists — lightweight membership probe.
 *
 * Internal read for the message service's per-user DM validation: it must reject
 * a targeted message addressed to a user who isn't an active member of the
 * recipient org. Returns `{ isMember: boolean }` and nothing else — no roster,
 * no PII. Authz: a service principal (the message service's signed token) or
 * anyone who may read the org (`canAccessOrg` — a member, an ancestor admin, a
 * platform admin), the same readers GET /organization/:id/members already
 * shows the whole roster to.
 */
export const checkOrganizationMembership = withController('Check membership', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = getParam(req.params, 'id')!;
  const userId = getParam(req.params, 'userId')!;
  if (!isServicePrincipal(req) && !(await canAccessOrg(req, id))) {
    return forbid(req, res, 'internal-service or org-access', 'Forbidden: service or organization member only');
  }

  const isMember = await orgMembersService.isActiveMember(id, userId);
  sendSuccess(res, 200, { isMember });
});

/** POST /organization/:id/members */
export const addMemberToOrganization = withController('Add member', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(addMemberSchema, req.body, res);
  if (!body) return;

  await orgMembersService.addMember(id, body, roleAssignmentActor(req));
  logger.info(`[ADD MEMBER TO ORG] User added to Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.member.add', {
    targetType: 'user',
    targetId: String(body.userId ?? body.email ?? ''),
    affectedOrgId: id,
    details: { role: body.role },
  });
  sendSuccess(res, 200, undefined, 'Member added successfully');
}, {
  [OM_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  // Carries a DISTINCT code: the UI adds members by email, and "no account for
  // that address" is satisfiable by sending an invitation. A bare NOT_FOUND
  // left the admin's intent expressed and unservable, with nothing naming the
  // route out.
  [OM_USER_NOT_FOUND]: { status: 404, message: 'No account exists for that address yet', code: ErrorCode.USER_NOT_REGISTERED },
  [OM_ALREADY_MEMBER]: { status: 400, message: 'User is already a member of this organization' },
  [OM_SEAT_LIMIT]: { status: 403, message: 'Seat limit reached for this plan — upgrade the plan or remove a member' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot add an admin: that grants permissions you do not hold yourself' },
  [OM_CONSENT_REQUIRED]: CONSENT_REQUIRED,
});

/** GET /organization/:id/member/:memberId/teams — descendant teams annotated
 *  with whether the member belongs to each (manage-teams view). */
export const getMemberTeams = withController('Get member teams', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  const memberId = req.params.memberId as string;
  // Read-level gate: own org (member), a managed team (parent admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return forbid(req, res, 'org-access', 'Forbidden: Can only view teams within your organization');
  }

  const result = await orgMembersService.listMemberTeams(id, memberId);
  sendSuccess(res, 200, result);
});

/** GET /organization/:id/teams — descendant team roster (no member context),
 *  for the "also add to teams" picker. */
export const getOrganizationTeams = withController('Get org teams', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  if (!(await canAccessOrg(req, id))) {
    return forbid(req, res, 'org-access', 'Forbidden: Can only view teams within your organization');
  }

  const result = await orgMembersService.listTeams(id);
  sendSuccess(res, 200, result);
});

/** POST /organization/:id/members/bulk-add — add one user to several teams in
 *  the org's subtree at once. */
export const bulkAddMemberToTeams = withController('Bulk add member to teams', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(bulkAddMemberSchema, req.body, res);
  if (!body) return;

  const { results } = await orgMembersService.bulkAddMemberToTeams(id, body, roleAssignmentActor(req));
  const added = results.filter((r) => r.status === 'added');
  logger.info(`[BULK ADD MEMBER] User added to ${added.length}/${results.length} team(s) under Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  // One audit row per team actually joined, each keyed to its own org so the
  // per-team audit trail matches a single add.
  for (const r of added) {
    audit(req, 'org.member.add', {
      targetType: 'user',
      targetId: String(body.userId ?? body.email ?? ''),
      affectedOrgId: r.orgId,
      details: { role: body.role, viaBulk: true },
    });
  }
  sendSuccess(res, 200, { results }, `Added to ${added.length} team(s)`);
}, {
  [OM_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [OM_TARGETS_OUT_OF_SCOPE]: { status: 403, message: 'One or more teams are outside your manageable organizations' },
  [OM_SEAT_LIMIT]: { status: 403, message: 'Seat limit reached for this plan — upgrade the plan or remove a member' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot add an admin: that grants permissions you do not hold yourself' },
  [OM_CONSENT_REQUIRED]: CONSENT_REQUIRED,
});

/**
 * Audit each pending invitation a member removal/deactivation revoked, as the
 * same `invitation.revoke` event the manual revoke emits — a withdrawn
 * invitation must be traceable whichever path withdrew it. `reason` and
 * `inviterId` say it was the cascade, not a direct revoke.
 */
function auditInviterExitRevocations(
  req: Parameters<typeof audit>[0],
  revoked: ReadonlyArray<{ invitationId: string; organizationId: string; email: string; role: string }>,
  inviterId: string,
  reason: 'inviter-removed' | 'inviter-deactivated',
): void {
  for (const inv of revoked) {
    audit(req, 'invitation.revoke', {
      targetType: 'invitation',
      targetId: inv.invitationId,
      affectedOrgId: inv.organizationId,
      details: { email: inv.email, role: inv.role, reason, inviterId },
    });
  }
}

/** DELETE /organization/:id/members/:userId */
export const removeMemberFromOrganization = withController('Remove member', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgScope(req, res, id))) return;
  if (admin.isOrgAdmin && userId === req.user!.sub) {
    return sendError(res, 400, 'Cannot remove yourself from the organization');
  }

  const { revokedInvitations } = await orgMembersService.removeMember(id, userId, roleAssignmentActor(req));
  logger.info(`[REMOVE MEMBER FROM ORG] User ${userId} removed from Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.member.remove', { targetType: 'user', targetId: userId, affectedOrgId: id });
  auditInviterExitRevocations(req, revokedInvitations, userId, 'inviter-removed');
  // Their stakeholder reports run with THEIR access, so they stop now rather than
  // at the next scheduled run. Fire-and-forget: the removal is what the admin asked
  // for and must not fail on an unreachable reporting service.
  void pauseFormerMemberReports(id, userId);
  sendSuccess(res, 200, undefined, 'Member removed successfully');
}, {
  [OM_NOT_A_MEMBER]: { status: 400, message: 'User is not a member of this organization' },
  [OM_CANNOT_REMOVE_OWNER]: { status: 400, message: 'Cannot remove organization owner. Transfer ownership first.' },
  ...STRIP_ROLE_REFUSALS,
});

/** PATCH /organization/:id/transfer-owner */
export const transferOrganizationOwnership = withController('Transfer ownership', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  const body = validateBody(transferOwnershipSchema, req.body, res);
  if (!body) return;

  const isSuperAdmin = isSystemAdmin(req);
  const isOrgOwner = await orgMembersService.isOrgOwner(id, req.user!.sub);
  if (!isSuperAdmin && !isOrgOwner) {
    return forbid(req, res, 'org-owner', 'Forbidden: Only system admin or organization owner can transfer ownership');
  }

  await orgMembersService.transferOwnership(id, body.newOwnerId);
  const adminType = isSuperAdmin ? 'system admin' : 'org owner';
  logger.info(`[TRANSFER ORG OWNERSHIP] Org ${id} ownership transferred to ${body.newOwnerId} by ${adminType} ${req.user!.sub}`);
  audit(req, 'org.ownership.transfer', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { newOwnerId: body.newOwnerId, actorType: adminType },
  });
  sendSuccess(res, 200, undefined, 'Ownership transferred successfully');
}, {
  [OM_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [OM_OWNER_MEMBERSHIP_NOT_FOUND]: { status: 500, message: 'Current owner membership record not found' },
  [OM_NEW_OWNER_MUST_BE_MEMBER]: { status: 400, message: 'New owner must be an active member of the organization' },
  [OM_ALREADY_OWNER]: { status: 400, message: 'That user already owns this organization' },
});

/** PATCH /organization/:id/members/:userId/deactivate */
export const deactivateMember = withController('Deactivate member', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgScope(req, res, id))) return;

  const { revokedInvitations } = await orgMembersService.deactivateMember(id, userId, roleAssignmentActor(req));
  logger.info(`[DEACTIVATE MEMBER] User ${userId} deactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.member.deactivate', { targetType: 'user', targetId: userId, affectedOrgId: id });
  auditInviterExitRevocations(req, revokedInvitations, userId, 'inviter-deactivated');
  // Same reason as the remove path: a report authorized as a deactivated account
  // would keep computing and mailing numbers nobody is accountable for. Reactivating
  // does NOT auto-resume them — see services/report-ownership.ts.
  void pauseFormerMemberReports(id, userId);
  sendSuccess(res, 200, undefined, 'Member deactivated successfully');
}, {
  [OM_MEMBERSHIP_NOT_FOUND]: { status: 404, message: 'Membership not found' },
  [OM_CANNOT_REMOVE_OWNER]: { status: 400, message: 'Cannot deactivate organization owner. Transfer ownership first.' },
  [OM_ALREADY_INACTIVE]: { status: 400, message: 'Member is already inactive' },
  ...STRIP_ROLE_REFUSALS,
});

/** PATCH /organization/:id/members/:userId/activate */
export const activateMember = withController('Activate member', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgScope(req, res, id))) return;

  await orgMembersService.activateMember(id, userId, roleAssignmentActor(req));
  logger.info(`[ACTIVATE MEMBER] User ${userId} reactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.member.activate', { targetType: 'user', targetId: userId, affectedOrgId: id });
  sendSuccess(res, 200, undefined, 'Member reactivated successfully');
}, {
  [OM_MEMBERSHIP_NOT_FOUND]: { status: 404, message: 'Membership not found' },
  [OM_ALREADY_ACTIVE]: { status: 400, message: 'Member is already active' },
  [RL_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can reactivate a member of a superadmin role' },
  [RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can reactivate a member of an ecosystem-management role' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot reactivate this member: they hold a role granting permissions you do not hold yourself' },
  [OM_SEAT_LIMIT]: { status: 403, message: 'Seat limit reached for this plan — upgrade the plan or remove a member' },
});
