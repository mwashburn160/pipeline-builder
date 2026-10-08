// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, paginationMeta, sendError, sendSuccess, errorMessage } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { requireOrgMembership, withController } from '../helpers/controller-helper.js';
import { isAncestorOrg } from '../helpers/org-hierarchy.js';
import { listPage } from '../helpers/pagination.js';
import type { InvitationOAuthProvider } from '../models/invitation.js';
import { auditService, invitationService } from '../services/index.js';
import type { InvitationDelivery } from '../services/invitation-service.js';
import { INV_ORG_NOT_FOUND, INV_UNAUTHORIZED, INV_ALREADY_MEMBER, INV_ALREADY_SENT, INV_MAX_REACHED, INV_SEAT_LIMIT, INV_INVITER_NOT_FOUND, INV_NOT_FOUND, INV_ACCEPTED, INV_EXPIRED, INV_REVOKED, INV_USER_NOT_FOUND, INV_EMAIL_MISMATCH, INV_OAUTH_NOT_ALLOWED, INV_EMAIL_NOT_ALLOWED, INV_NOT_PENDING } from '../services/invitation-errors.js';
import { verifyOAuthCode, OAUTH_ERROR_MAP } from '../services/oauth-providers.js';
import { validateBody, sendInvitationSchema } from '../utils/validation.js';

const logger = createLogger('invitation-controller');

/** Privileged role check for invitation operations. Both `admin` and `owner`
 *  qualify — owners are a superset of admins for org-level management. */
function isOrgManager(role: string | undefined): boolean {
  return role === 'admin' || role === 'owner';
}

const acceptErrorMap = {
  [INV_NOT_FOUND]: { status: 404, message: 'Invitation not found' },
  [INV_ACCEPTED]: { status: 400, message: 'Invitation has already been accepted' },
  [INV_EXPIRED]: { status: 400, message: 'Invitation has expired' },
  [INV_REVOKED]: { status: 400, message: 'Invitation has been revoked' },
  [INV_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [INV_EMAIL_MISMATCH]: { status: 403, message: 'This invitation was sent to a different email address' },
  [INV_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [INV_ALREADY_MEMBER]: { status: 400, message: 'You are already a member of this organization' },
  [INV_OAUTH_NOT_ALLOWED]: { status: 403, message: 'This invitation cannot be accepted via OAuth' },
  [INV_EMAIL_NOT_ALLOWED]: { status: 403, message: 'This invitation can only be accepted via OAuth' },
};

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
async function resolveInviteTarget(actorOrgId: string, targetOrgId: string | undefined, res: Response): Promise<string | null> {
  if (!targetOrgId || targetOrgId === actorOrgId) return actorOrgId;
  if (!(await isAncestorOrg(actorOrgId, targetOrgId))) {
    sendError(res, 403, 'You can only invite into your own organization or one of its teams');
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

  const targetOrgId = await resolveInviteTarget(orgId, body.targetOrgId, res);
  if (!targetOrgId) return;

  // Duplicates inside one paste would otherwise fight each other (the first
  // creates, the rest come back ALREADY_SENT) and read as failures.
  const emails = [...new Set(body.emails.map((e) => e.toLowerCase()))];

  const sent: Array<{ email: string; delivery: InvitationDelivery; acceptUrl?: string }> = [];
  const failed: Array<{ email: string; reason: string }> = [];

  // Sequential, not Promise.all: the pending cap and the seat guard are read
  // per send, and firing them concurrently is exactly the race this shape
  // exists to remove.
  for (const email of emails) {
    try {
      const { invitation, delivery } = await invitationService.send({
        orgId: targetOrgId,
        inviterId: req.user!.sub,
        inviterIsAdmin: isOrgManager(req.user?.role),
        email,
        role: body.role,
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
        details: { email: invitation.email, role: invitation.role },
      });
    } catch (err) {
      // The service throws sentinel strings (see invitation-errors); map the
      // ones a caller can act on, and never leak an internal message.
      failed.push({ email, reason: SEND_REASONS[errorMessage(err)] ?? 'Could not be invited' });
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
  [INV_SEAT_LIMIT]: 'No seat available — free one or add a seat pack',
  [INV_UNAUTHORIZED]: 'You are not authorized to invite to this organization',
  [INV_ORG_NOT_FOUND]: 'Organization not found',
  [INV_INVITER_NOT_FOUND]: 'Inviter not found',
};

/** POST /invitation/accept — accept invitation as the logged-in user. */
export const acceptInvitation = withController('Accept invitation', async (req, res) => {
  const { token } = req.body;
  if (!token) return sendError(res, 400, 'Invitation token is required');
  if (!req.user) return sendError(res, 401, 'You must be logged in to accept an invitation');

  const oauthProvider = req.headers['x-oauth-provider'] as InvitationOAuthProvider | undefined;
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
    details: { email: accepted.email, role: accepted.role },
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
  const accepted = await invitationService.acceptViaOAuth(token, oauthProvider as InvitationOAuthProvider, verified);

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
    details: { email: accepted.email, role: accepted.role, via: oauthProvider },
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
    invitationId as string, orgId, req.user!.sub, isOrgManager(req.user!.role),
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
    invitationId as string, orgId, req.user!.sub, isOrgManager(req.user!.role),
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
