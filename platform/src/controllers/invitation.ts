// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, paginationMeta, sendError, sendSuccess, errorMessage, seatRemedy, isSystemAdmin, userHasPermission } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { isAdminOrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import { audit } from '../helpers/audit.js';
import { forbid, requireOrgMembership, withController, roleAssignmentActor } from '../helpers/controller-helper.js';
import { isAncestorOrg } from '../helpers/org-hierarchy.js';
import { listPage } from '../helpers/pagination.js';
import { pooledSeatUsage } from '../helpers/seats.js';
import { auditService, invitationService } from '../services/index.js';
import { INVITATION_ACCEPT_ERRORS, INV_ADMIN_REQUIRES_ADMIN, INV_ALREADY_MEMBER, INV_ALREADY_SENT, INV_EMAIL_MISMATCH, INV_INVITER_NOT_FOUND, INV_MAX_REACHED, INV_NOT_FOUND, INV_NOT_PENDING, INV_ORG_NOT_FOUND, INV_SEAT_LIMIT, INV_UNAUTHORIZED } from '../services/invitation-errors.js';
import type { InvitationDelivery } from '../services/invitation-service.js';
import { verifyOAuthCode, OAUTH_ERROR_MAP } from '../services/oauth-providers.js';
import { RL_ASSIGN_EXCEEDS_CEILING, RL_ROLE_NOT_FOUND, RL_SUPERADMIN_ROLE_NOT_INVITABLE, RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN } from '../services/roles-errors.js';
import { partitionAssignableRoles } from '../services/roles-service.js';
import { isOAuthProviderName, type OAuthProviderName } from '../types/oauth-provider.js';
import { validateBody, sendInvitationSchema } from '../utils/validation.js';

const logger = createLogger('invitation-controller');

/**
 * May this caller manage the org's invitations?
 *
 * `invitations:manage` — which the route gate already proved — or the superadmin
 * flag. It is NOT the coarse admin label, and that distinction is the whole
 * point: the service used to demand admin/owner on every write, which made the
 * permission unusable and broke the shipped `People Manager` template, whose
 * holders are deliberately not admins.
 */
function invitationManager(req: Request): boolean {
  return userHasPermission(req, 'invitations:manage') || isSystemAdmin(req);
}

/**
 * Why a selected Role could not be granted: the caller's words AND the status,
 * one entry per reason. A ceiling failure is a 403 (you may not grant this); a
 * bad id is a 400 (the request is malformed).
 *
 * ONE entry carrying both, matching `service-accounts.ts` and
 * `organization-members.ts`, which already map a rejection reason to
 * `{ status, message }`. This was the outlier: two maps over the same key set,
 * read together at the one call site, so a reason added to one and forgotten in
 * the other produced a 400 with someone else's wording — and the `?? 400` /
 * `?? 'One of the selected roles…'` fallbacks made that silent.
 */
const ROLE_REJECTIONS: Record<string, { status: number; message: string }> = {
  [RL_ROLE_NOT_FOUND]: {
    status: 400,
    message: 'One of the selected roles does not exist in that organization',
  },
  [RL_SUPERADMIN_ROLE_NOT_INVITABLE]: {
    status: 403,
    message: 'The Super Admin role cannot be granted by invitation — use the platform-admin grant, which requires a second factor',
  },
  [RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN]: {
    status: 403,
    message: 'That role carries platform permissions and can only be assigned by a Super Admin',
  },
  [RL_ASSIGN_EXCEEDS_CEILING]: {
    status: 403,
    message: 'That role grants permissions you do not hold yourself',
  },
};


const acceptErrorMap = INVITATION_ACCEPT_ERRORS;

const acceptOAuthErrorMap = {
  ...acceptErrorMap,
  ...OAUTH_ERROR_MAP,
  [INV_EMAIL_MISMATCH]: { status: 403, message: 'OAuth email does not match invitation email' },
};

/**
 * Which org an invitation actually joins.
 *
 * Defaults to the actor's own. A `targetOrgId` must be that org or a DESCENDANT
 * of it — an admin may staff their own teams, never a sibling or a stranger's
 * org. Checked here rather than in the schema because it is an authorization
 * question about the caller, not a shape question about the body.
 *
 * Responds and returns null when it refuses, so callers `if (!target) return;`.
 */
async function resolveInviteTarget(req: Request, actorOrgId: string, targetOrgId: string | undefined, res: Response): Promise<string | null> {
  if (!targetOrgId || targetOrgId === actorOrgId) return actorOrgId;
  if (!(await isAncestorOrg(actorOrgId, targetOrgId))) {
    forbid(req, res, 'org-scope', 'You can only invite into your own organization or one of its teams');
    return null;
  }
  return targetOrgId;
}

/**
 * POST /invitation/send — invite one or MANY addresses in a single request.
 *
 * Deliberately NOT one transaction. Each address is independently valid or not
 * — already a member, already invited, over the seat cap — and one bad address
 * must not roll back the thirty that were fine. Each outcome is reported
 * instead, which is what the caller has to show anyway.
 */
export const sendInvitation = withController('Send invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const body = validateBody(sendInvitationSchema, req.body, res);
  if (!body) return;

  const targetOrgId = await resolveInviteTarget(req, orgId, body.targetOrgId, res);
  if (!targetOrgId) return;

  // Roles are validated ONCE, before the loop, and a rejection fails the whole
  // REQUEST rather than landing in `failed[]`: the same ids apply to every
  // address, so "this Role is not yours to grant" is not a per-address outcome.
  // (The per-address shape is for already-a-member, already-invited, no-seat.)
  const { eligible: roleIds, rejected } = await partitionAssignableRoles(
    targetOrgId as unknown as Parameters<typeof partitionAssignableRoles>[0],
    body.roleIds,
    roleAssignmentActor(req),
  );
  if (rejected.length > 0) {
    const first = rejected[0]!;
    // One lookup, so the status and the wording can no longer come from
    // different reasons; an unmapped reason falls back to both halves together.
    const rejection = ROLE_REJECTIONS[first.reason]
      ?? { status: 400, message: 'One of the selected roles cannot be granted' };
    return sendError(res, rejection.status, rejection.message, first.reason, { roleId: first.roleId });
  }

  // Duplicates inside one paste would otherwise fight each other (the first
  // creates, the rest come back ALREADY_SENT) and read as failures.
  const emails = [...new Set(body.emails.map((e) => e.toLowerCase()))];

  const sent: Array<{ email: string; delivery: InvitationDelivery; acceptUrl?: string }> = [];
  const failed: Array<{ email: string; reason: string }> = [];
  // The out-of-seats wording depends on the ACCOUNT's tier (see seatLimitReason),
  // looked up once and only if a send actually hit the cap.
  let seatReason: Promise<string> | undefined;

  // Sequential, not Promise.all: the pending cap and the seat guard are read
  // per send, and firing them concurrently is exactly the race this shape
  // exists to remove.
  for (const email of emails) {
    try {
      const { invitation, delivery } = await invitationService.send({
        orgId: targetOrgId,
        inviterId: req.user!.sub,
        // The permission the ROUTE proved, and separately the admin ceiling.
        inviterCanManage: userHasPermission(req, 'invitations:manage') || isSystemAdmin(req),
        inviterIsAdmin: isAdminOrgRole(req.user?.role) || isSystemAdmin(req),
        email,
        role: body.role,
        roleIds: roleIds.map(String),
        invitationType: body.invitationType,
        allowedOAuthProviders: body.allowedOAuthProviders,
      });
      sent.push({
        email,
        delivery,
        // The accept link, ONCE, and only when the email did not carry it.
        //
        // The token is a bearer credential, which is why listings strip it and
        // the audit record never holds it — but withholding it from the inviter
        // who just created it left an undeliverable invitation with no recovery
        // at all. This is the single response that may carry it: the creator is
        // authorised and it is their own invitation.
        ...(delivery === 'sent' ? {} : { acceptUrl: `${config.app.frontendUrl}/invite/accept?token=${invitation.token}` }),
      });
      if (delivery === 'failed') {
        logger.warn('Failed to send invitation email, but invitation created', { invitationId: invitation._id });
      }
      // NEVER the token — email + role only. `affectedOrgId` is the org being
      // JOINED, which with a team target is not the actor's own.
      audit(req, 'invitation.send', {
        targetType: 'invitation',
        targetId: String(invitation._id),
        affectedOrgId: targetOrgId,
        details: {
          email: invitation.email,
          role: invitation.role,
          ...(roleIds.length > 0 && { roleIds: roleIds.map(String) }),
        },
      });
    } catch (err) {
      // The service throws sentinel strings (see invitation-errors); map the
      // ones a caller can act on, and never leak an internal message.
      const code = errorMessage(err);
      const reason = code === INV_SEAT_LIMIT
        ? await (seatReason ??= seatLimitReason(targetOrgId))
        : SEND_REASONS[code];
      failed.push({ email, reason: reason ?? 'Could not be invited' });
    }
  }

  logger.info('Invitations processed', { organizationId: targetOrgId, requested: emails.length, sent: sent.length, failed: failed.length });
  sendSuccess(res, 200, { sent, failed }, `${sent.length} invited, ${failed.length} failed`);
});

/**
 * Per-address outcomes a caller can act on, in the caller's words.
 *
 * This REPLACES the old `sendErrorMap`, and changes the contract deliberately:
 * a per-address problem (already a member, already invited, no seat) used to
 * fail the whole request with a 4xx, which cannot express "three of five
 * landed". It is now a 200 whose `failed[]` names each one. A request-level
 * refusal — no permission, a target org that is not yours — is still a 4xx.
 */
const SEND_REASONS: Record<string, string> = {
  [INV_ALREADY_MEMBER]: 'Already a member of this organization',
  [INV_ALREADY_SENT]: 'Already has a pending invitation',
  [INV_MAX_REACHED]: 'The organization has too many pending invitations',
  [INV_UNAUTHORIZED]: 'You are not authorized to invite to this organization',
  [INV_ORG_NOT_FOUND]: 'Organization not found',
  [INV_INVITER_NOT_FOUND]: 'Inviter not found',
  // A CEILING, not a refusal: the caller may invite, just not as an admin.
  [INV_ADMIN_REQUIRES_ADMIN]: 'Only an admin or owner can invite someone as an admin',
};

/**
 * Why an invite was refused for lack of a seat, with the remedy the ACCOUNT can
 * actually use. Seat packs are sold only on Team and above (api-core
 * SEAT_PACK_TIERS, which the billing catalog uses too), so "add a seat pack"
 * told a Developer or Pro admin to buy something billing would not sell them —
 * their way to more seats is a plan upgrade. Falls back to the plain fact when
 * the tier cannot be read: never let the wording fail the request.
 */
async function seatLimitReason(orgId: string): Promise<string> {
  try {
    const { tier } = await pooledSeatUsage(orgId);
    switch (seatRemedy(tier)) {
      case 'upgrade': return 'No seat available — your plan includes no more seats; upgrade to Team to add members';
      case 'seat_pack': return 'No seat available — free one or add a seat pack';
      default: return 'No seat available — free a seat to invite more';
    }
  } catch {
    return 'No seat available — free a seat to invite more';
  }
}

/** POST /invitation/accept — accept invitation as the logged-in user. */
export const acceptInvitation = withController('Accept invitation', async (req, res) => {
  const { token } = req.body;
  if (!token) return sendError(res, 400, 'Invitation token is required');
  if (!req.user) return sendError(res, 401, 'You must be logged in to accept an invitation');

  // Client-asserted: the service honours it only when the account holds a
  // linked identity at that provider.
  const providerHeader = req.headers['x-oauth-provider'];
  let oauthProvider: OAuthProviderName | undefined;
  if (providerHeader !== undefined) {
    if (typeof providerHeader !== 'string' || !isOAuthProviderName(providerHeader)) {
      return sendError(res, 400, 'Unknown OAuth provider');
    }
    oauthProvider = providerHeader;
  }
  const accepted = await invitationService.accept(token, req.user.sub, oauthProvider);

  // Accepting an invite creates a membership — a self-serve privilege grant, so
  // it's audited alongside the other membership mutations. `req.user` IS the
  // accepting user (guarded above), so it's recorded as the actor.
  // `affectedOrgId` is the invitation's org (the org being JOINED — NOT the
  // actor's current org). NEVER the token — email + role only.
  audit(req, 'invitation.accept', {
    targetType: 'invitation',
    targetId: accepted.invitationId,
    affectedOrgId: accepted.organizationId,
    details: {
      email: accepted.email,
      role: accepted.role,
      // Accepting an invitation that named Roles IS a privilege grant. The
      // event used to record the coarse role alone, so a trail could say
      // somebody joined as a `member` while the same act handed them
      // `Security Officer`. `dropped` is the only durable record that the
      // invitation promised something the inviter had since lost the authority
      // to give — the question somebody asks when the person cannot do the job.
      ...(accepted.grantedRoleIds && { grantedRoleIds: accepted.grantedRoleIds }),
      ...(accepted.droppedRoleIds && { droppedRoleIds: accepted.droppedRoleIds }),
    },
  });

  logger.info('Invitation accepted', { userId: req.user.sub, oauthProvider });
  sendSuccess(res, 200, undefined, 'Invitation accepted successfully');
}, acceptErrorMap);

/** POST /invitation/accept-oauth — first-time OAuth-based accept (creates user if needed).
 *  Public route: the caller supplies the OAuth authorization `code` + `state`
 *  (obtained via the normal /auth/url → provider redirect), NOT a profile. The
 *  identity is verified SERVER-SIDE via {@link verifyOAuthCode}: accepting a
 *  client-supplied `oauthData` would let anyone holding an invite token bind
 *  the invitee's email to an attacker-chosen account (org/account takeover). */
export const acceptInvitationViaOAuth = withController('Accept invitation via OAuth', async (req, res) => {
  const { token, oauthProvider, code, state } = req.body ?? {};
  if (!token) return sendError(res, 400, 'Invitation token is required');
  if (!oauthProvider || !['google'].includes(oauthProvider)) {
    return sendError(res, 400, 'Valid OAuth provider is required');
  }
  if (typeof code !== 'string' || !code || typeof state !== 'string' || !state) {
    return sendError(res, 400, 'OAuth authorization code and state are required');
  }

  // Exchange the code with the provider and use the VERIFIED identity — never
  // trust a client-supplied profile.
  const verified = await verifyOAuthCode(oauthProvider, code, state, req);
  const accepted = await invitationService.acceptViaOAuth(token, oauthProvider as OAuthProviderName, verified);

  // Public route: there is no `req.user`, so `audit(req, ...)` would file the
  // membership grant under an anonymous actor. Attribute it to the user resolved
  // (or created) server-side via createEvent, so the audit answers "who joined".
  // Fire-and-forget — an audit error must never fail the accept. NEVER the token.
  auditService.createEvent({
    action: 'invitation.accept',
    actorId: accepted.userId,
    actorEmail: accepted.email,
    orgId: accepted.organizationId,
    affectedOrgId: accepted.organizationId,
    targetType: 'invitation',
    targetId: accepted.invitationId,
    outcome: 'success',
    ip: req.ip,
    details: {
      email: accepted.email,
      role: accepted.role,
      via: oauthProvider,
      // The same grant on the OAuth path — both accept routes reach
      // `processAcceptance`, so both must record what it granted.
      ...(accepted.grantedRoleIds && { grantedRoleIds: accepted.grantedRoleIds }),
      ...(accepted.droppedRoleIds && { droppedRoleIds: accepted.droppedRoleIds }),
    },
  }).catch((err) => logger.warn('Failed to write invitation.accept audit event', { error: errorMessage(err) }));

  logger.info('Invitation accepted via OAuth', { oauthProvider });
  sendSuccess(res, 200, undefined, 'Invitation accepted successfully via OAuth');
}, acceptOAuthErrorMap);

/** GET /invitation/:token — public preview before accepting. */
export const getInvitation = withController('Get invitation', async (req, res) => {
  const { token } = req.params;
  if (!token) return sendError(res, 400, 'Invitation token is required');

  const invitation = await invitationService.getByToken(token as string);
  if (!invitation) return sendError(res, 404, 'Invitation not found');

  sendSuccess(res, 200, {
    invitation: {
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organization: invitation.organizationId,
      invitedBy: invitation.invitedBy,
      isValid: invitation.isValid(),
      invitationType: invitation.invitationType,
      allowedOAuthProviders: invitation.allowedOAuthProviders,
      canAcceptViaEmail: invitation.canAcceptViaEmail(),
      canAcceptViaGoogle: invitation.canAcceptViaOAuth('google'),
    },
  });
});

/** GET /invitation/list — invitations for the current org. */
export const listInvitations = withController('List invitations', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const { status, invitationType, role, search } = req.query;
  const { offset, limit: limitNum } = listPage(req.query);

  const { invitations, total } = await invitationService.listForOrg(orgId, {
    status: status as string | undefined,
    invitationType: invitationType as string | undefined,
    // Coarse invite role filter (service whitelists admin|member) + a
    // case-insensitive email substring search.
    role: typeof role === 'string' ? role : undefined,
    search: typeof search === 'string' ? search : undefined,
    offset,
    limit: limitNum,
  });

  sendSuccess(res, 200, {
    invitations,
    pagination: paginationMeta({ total, offset, limit: limitNum }),
  });
});

/** DELETE /invitation/:invitationId — owner/admin only. */
export const revokeInvitation = withController('Revoke invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;
  const { invitationId } = req.params;

  const revoked = await invitationService.revoke(
    invitationId as string, orgId, req.user!.sub, invitationManager(req),
  );

  audit(req, 'invitation.revoke', {
    targetType: 'invitation',
    targetId: revoked.invitationId,
    affectedOrgId: revoked.organizationId,
    details: { email: revoked.email, role: revoked.role },
  });

  logger.info('Invitation revoked', { invitationId, revokedBy: req.user!.sub });
  sendSuccess(res, 200, undefined, 'Invitation revoked successfully');
}, {
  [INV_NOT_FOUND]: { status: 404, message: 'Invitation not found' },
  [INV_NOT_PENDING]: { status: 400, message: 'Cannot revoke invitation that is not pending' },
  [INV_UNAUTHORIZED]: { status: 403, message: 'You are not authorized to revoke invitations' },
});

/** POST /invitation/:invitationId/resend — owner/admin only. */
export const resendInvitation = withController('Resend invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;
  const { invitationId } = req.params;

  const { expiresAt, delivery, email, role } = await invitationService.resend(
    invitationId as string, orgId, req.user!.sub, invitationManager(req),
  );

  // A configured transport that REFUSED is a real failure; a deployment with no
  // mail at all is not, and 500-ing there would make resend permanently broken
  // on every install that runs without email.
  if (delivery === 'failed') {
    return sendError(res, 500, 'Failed to send invitation email');
  }

  audit(req, 'invitation.resend', {
    targetType: 'invitation',
    targetId: invitationId as string,
    affectedOrgId: orgId,
    details: { email, role },
  });

  logger.info('Invitation resent', { invitationId, delivery });
  sendSuccess(res, 200, { expiresAt, delivery }, 'Invitation resent successfully');
}, {
  [INV_NOT_FOUND]: { status: 404, message: 'Pending invitation not found' },
  [INV_UNAUTHORIZED]: { status: 403, message: 'You are not authorized to resend invitations' },
  [INV_INVITER_NOT_FOUND]: { status: 404, message: 'Inviter not found' },
});
