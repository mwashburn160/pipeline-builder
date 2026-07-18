// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, parsePaginationParams } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import {
  canAccessOrg,
  requireOrgAdmin,
  isSystemAdmin,
  requireAuth,
  getAdminContext,
  withController,
} from '../helpers/controller-helper.js';
import {
  orgMembersService,
  OM_ORG_NOT_FOUND, OM_USER_NOT_FOUND, OM_ALREADY_MEMBER, OM_NOT_A_MEMBER,
  OM_CANNOT_REMOVE_OWNER, OM_OWNER_MEMBERSHIP_NOT_FOUND,
  OM_NEW_OWNER_MUST_BE_MEMBER, OM_MEMBERSHIP_NOT_FOUND, OM_ALREADY_INACTIVE, OM_ALREADY_ACTIVE,
  OM_TARGETS_OUT_OF_SCOPE, OM_SEAT_LIMIT,
} from '../services/index.js';
import {
  validateBody,
  addMemberSchema,
  bulkAddMemberSchema,
  transferOwnershipSchema,
} from '../utils/validation.js';

const logger = createLogger('organization-members-controller');

/** GET /organization/:id/members */
export const getOrganizationMembers = withController('Get members', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  // Own org (any member), a team you manage (parent-org admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: Can only view members of your organization');
  }

  // Bound the roster: parse limit/offset + optional search/role, and push them
  // into the DB query (service-side, never in-memory) so a large org doesn't
  // ship its whole membership. Mirrors the paginated list endpoints' shape.
  const { offset, limit } = parsePaginationParams(req.query);
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const roleRaw = typeof req.query.role === 'string' ? req.query.role : undefined;
  const role = roleRaw === 'owner' || roleRaw === 'admin' || roleRaw === 'member' ? roleRaw : undefined;

  const result = await orgMembersService.listMembers(id, { offset, limit, search, role });
  if (!result) return sendError(res, 404, 'Organization not found');

  const { members, total, offset: off, limit: lim, organizationId, organizationName, ownerId } = result;
  sendSuccess(res, 200, {
    organizationId,
    organizationName,
    ownerId,
    members,
    pagination: { total, offset: off, limit: lim, hasMore: off + lim < total },
  });
});

/** POST /organization/:id/members */
export const addMemberToOrganization = withController('Add member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;

  const body = validateBody(addMemberSchema, req.body, res);
  if (!body) return;

  await orgMembersService.addMember(id, body);
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
  [OM_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [OM_ALREADY_MEMBER]: { status: 400, message: 'User is already a member of this organization' },
  [OM_SEAT_LIMIT]: { status: 403, message: 'Seat limit reached for this plan — upgrade the plan or remove a member' },
});

/** GET /organization/:id/member/:memberId/teams — descendant teams annotated
 *  with whether the member belongs to each (manage-teams view). */
export const getMemberTeams = withController('Get member teams', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const memberId = req.params.memberId as string;
  // Read-level gate: own org (member), a managed team (parent admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: Can only view teams within your organization');
  }

  const result = await orgMembersService.listMemberTeams(id, memberId);
  sendSuccess(res, 200, result);
});

/** GET /organization/:id/teams — descendant team roster (no member context),
 *  for the "also add to teams" picker. */
export const getOrganizationTeams = withController('Get org teams', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: Can only view teams within your organization');
  }

  const result = await orgMembersService.listTeams(id);
  sendSuccess(res, 200, result);
});

/** POST /organization/:id/members/bulk-add — add one user to several teams in
 *  the org's subtree at once. */
export const bulkAddMemberToTeams = withController('Bulk add member to teams', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;

  const body = validateBody(bulkAddMemberSchema, req.body, res);
  if (!body) return;

  const { results } = await orgMembersService.bulkAddMemberToTeams(id, body);
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
});

/** DELETE /organization/:id/members/:userId */
export const removeMemberFromOrganization = withController('Remove member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;
  if (admin.isOrgAdmin && userId === req.user!.sub) {
    return sendError(res, 400, 'Cannot remove yourself from the organization');
  }

  await orgMembersService.removeMember(id, userId);
  logger.info(`[REMOVE MEMBER FROM ORG] User ${userId} removed from Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.member.remove', { targetType: 'user', targetId: userId, affectedOrgId: id });
  sendSuccess(res, 200, undefined, 'Member removed successfully');
}, {
  [OM_NOT_A_MEMBER]: { status: 400, message: 'User is not a member of this organization' },
  [OM_CANNOT_REMOVE_OWNER]: { status: 400, message: 'Cannot remove organization owner. Transfer ownership first.' },
});

/** PATCH /organization/:id/transfer-owner */
export const transferOrganizationOwnership = withController('Transfer ownership', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const body = validateBody(transferOwnershipSchema, req.body, res);
  if (!body) return;

  const isSuperAdmin = isSystemAdmin(req);
  const isOrgOwner = await orgMembersService.isOrgOwner(id, req.user!.sub);
  if (!isSuperAdmin && !isOrgOwner) {
    return sendError(res, 403, 'Forbidden: Only system admin or organization owner can transfer ownership');
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
  [OM_NEW_OWNER_MUST_BE_MEMBER]: { status: 400, message: 'New owner must be a member of the organization' },
});

/** PATCH /organization/:id/members/:userId/deactivate */
export const deactivateMember = withController('Deactivate member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;

  await orgMembersService.deactivateMember(id, userId);
  logger.info(`[DEACTIVATE MEMBER] User ${userId} deactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.member.deactivate', { targetType: 'user', targetId: userId, affectedOrgId: id });
  sendSuccess(res, 200, undefined, 'Member deactivated successfully');
}, {
  [OM_MEMBERSHIP_NOT_FOUND]: { status: 404, message: 'Membership not found' },
  [OM_CANNOT_REMOVE_OWNER]: { status: 400, message: 'Cannot deactivate organization owner. Transfer ownership first.' },
  [OM_ALREADY_INACTIVE]: { status: 400, message: 'Member is already inactive' },
});

/** PATCH /organization/:id/members/:userId/activate */
export const activateMember = withController('Activate member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;

  await orgMembersService.activateMember(id, userId);
  logger.info(`[ACTIVATE MEMBER] User ${userId} reactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.member.activate', { targetType: 'user', targetId: userId, affectedOrgId: id });
  sendSuccess(res, 200, undefined, 'Member reactivated successfully');
}, {
  [OM_MEMBERSHIP_NOT_FOUND]: { status: 404, message: 'Membership not found' },
  [OM_ALREADY_ACTIVE]: { status: 400, message: 'Member is already active' },
  [OM_SEAT_LIMIT]: { status: 403, message: 'Seat limit reached for this plan — upgrade the plan or remove a member' },
});
