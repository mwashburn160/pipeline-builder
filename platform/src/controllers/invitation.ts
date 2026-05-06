// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { config } from '../config';
import { requireOrgMembership, withController } from '../helpers/controller-helper';
import type { InvitationOAuthProvider } from '../models/invitation';
import {
  invitationService,
  INV_ORG_NOT_FOUND, INV_UNAUTHORIZED, INV_ALREADY_MEMBER, INV_ALREADY_SENT, INV_MAX_REACHED,
  INV_INVITER_NOT_FOUND, INV_NOT_FOUND, INV_ACCEPTED, INV_EXPIRED, INV_REVOKED,
  INV_USER_NOT_FOUND, INV_EMAIL_MISMATCH, INV_OAUTH_NOT_ALLOWED, INV_EMAIL_NOT_ALLOWED, INV_NOT_PENDING,
} from '../services';
import { parsePagination } from '../utils/pagination';
import { validateBody, sendInvitationSchema } from '../utils/validation';

const logger = createLogger('InvitationController');

const sendErrorMap = {
  [INV_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [INV_UNAUTHORIZED]: { status: 403, message: 'You are not authorized to send invitations' },
  [INV_ALREADY_MEMBER]: { status: 400, message: 'User is already a member of this organization' },
  [INV_ALREADY_SENT]: { status: 400, message: 'An invitation has already been sent to this email' },
  [INV_MAX_REACHED]: { status: 400, message: 'Maximum pending invitations reached' },
  [INV_INVITER_NOT_FOUND]: { status: 404, message: 'Inviter not found' },
};

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
  [INV_EMAIL_MISMATCH]: { status: 403, message: 'OAuth email does not match invitation email' },
};

/** POST /invitation/send — invite a user to an org by email. */
export const sendInvitation = withController('Send invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  if (orgId.toLowerCase() === SYSTEM_ORG_ID) {
    return sendError(res, 400, 'System org does not support invitations');
  }

  const body = validateBody(sendInvitationSchema, req.body, res);
  if (!body) return;

  const { invitation, emailSent } = await invitationService.send({
    orgId,
    inviterId: req.user!.sub,
    inviterIsAdmin: req.user?.role === 'admin',
    email: body.email,
    role: body.role,
    invitationType: body.invitationType,
    allowedOAuthProviders: body.allowedOAuthProviders,
  });

  if (!emailSent && config.email.enabled) {
    logger.warn('Failed to send invitation email, but invitation created', { invitationId: invitation._id });
  }

  logger.info('Invitation sent', {
    invitationId: invitation._id, email: body.email, organizationId: orgId, role: body.role,
  });

  sendSuccess(res, 201, {
    invitation: {
      id: invitation._id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      invitationType: invitation.invitationType,
      allowedOAuthProviders: invitation.allowedOAuthProviders,
    },
  }, 'Invitation sent successfully');
}, sendErrorMap);

/** POST /invitation/accept — accept invitation as the logged-in user. */
export const acceptInvitation = withController('Accept invitation', async (req, res) => {
  const { token } = req.body;
  if (!token) return sendError(res, 400, 'Invitation token is required');
  if (!req.user) return sendError(res, 401, 'You must be logged in to accept an invitation');

  const oauthProvider = req.headers['x-oauth-provider'] as InvitationOAuthProvider | undefined;
  await invitationService.accept(token, req.user.sub, oauthProvider);

  logger.info('Invitation accepted', { token, userId: req.user.sub, oauthProvider });
  sendSuccess(res, 200, undefined, 'Invitation accepted successfully');
}, acceptErrorMap);

/** POST /invitation/accept-oauth — first-time OAuth-based accept (creates user if needed). */
export const acceptInvitationViaOAuth = withController('Accept invitation via OAuth', async (req, res) => {
  const { token, oauthProvider, oauthData } = req.body;
  if (!token) return sendError(res, 400, 'Invitation token is required');
  if (!oauthProvider || !['google'].includes(oauthProvider)) {
    return sendError(res, 400, 'Valid OAuth provider is required');
  }
  if (!oauthData || !oauthData.id || !oauthData.email) {
    return sendError(res, 400, 'OAuth data with id and email is required');
  }

  await invitationService.acceptViaOAuth(token, oauthProvider as InvitationOAuthProvider, oauthData);

  logger.info('Invitation accepted via OAuth', { token, oauthProvider });
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

  if (orgId.toLowerCase() === SYSTEM_ORG_ID) {
    return sendSuccess(res, 200, {
      invitations: [],
      pagination: { total: 0, offset: 0, limit: 25, hasMore: false },
    });
  }

  const { status, invitationType } = req.query;
  const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);

  const { invitations, total } = await invitationService.listForOrg(orgId, {
    status: status as string | undefined,
    invitationType: invitationType as string | undefined,
    offset,
    limit: limitNum,
  });

  sendSuccess(res, 200, {
    invitations,
    pagination: { total, offset, limit: limitNum, hasMore: offset + limitNum < total },
  });
});

/** DELETE /invitation/:invitationId — owner/admin only. */
export const revokeInvitation = withController('Revoke invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;
  const { invitationId } = req.params;

  await invitationService.revoke(
    invitationId as string, orgId, req.user!.sub, req.user!.role === 'admin',
  );

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

  const { expiresAt, emailSent } = await invitationService.resend(
    invitationId as string, orgId, req.user!.sub, req.user!.role === 'admin',
  );

  if (!emailSent && config.email.enabled) {
    return sendError(res, 500, 'Failed to send invitation email');
  }

  logger.info('Invitation resent', { invitationId });
  sendSuccess(res, 200, { expiresAt }, 'Invitation resent successfully');
}, {
  [INV_NOT_FOUND]: { status: 404, message: 'Pending invitation not found' },
  [INV_UNAUTHORIZED]: { status: 403, message: 'You are not authorized to resend invitations' },
  [INV_INVITER_NOT_FOUND]: { status: 404, message: 'Inviter not found' },
});
