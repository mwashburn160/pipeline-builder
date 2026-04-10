// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess } from '@mwashburn160/api-core';
import mongoose from 'mongoose';
import { config } from '../config';
import { requireOrgMembership, withController } from '../helpers/controller-helper';
import { Invitation, InvitationDocument, Organization, OrganizationDocument, User, UserDocument, UserOrganization } from '../models';
import { InvitationOAuthProvider } from '../models/invitation';
import { emailService } from '../utils/email';
import { parsePagination } from '../utils/pagination';
import { validateBody, sendInvitationSchema } from '../utils/validation';

const logger = createLogger('InvitationController');

// Invitation Helpers

/**
 * Calculate an invitation expiration date from now.
 * @returns Date offset by the configured expiration days
 */
function getExpirationDate(): Date {
  return new Date(Date.now() + config.invitation.expirationDays * 24 * 60 * 60 * 1000);
}

/**
 * Send a fire-and-forget notification email to the original inviter
 * when an invitation is accepted.
 */
async function notifyInviter(invitation: InvitationDocument, user: UserDocument, org: OrganizationDocument, session: mongoose.ClientSession): Promise<void> {
  const inviter = await User.findById(invitation.invitedBy).session(session);
  if (inviter) {
    emailService.sendInvitationAccepted(
      inviter.email,
      inviter.username,
      user.username,
      org.name,
    ).catch(error => logger.error('Failed to send acceptance notification:', error));
  }
}

/**
 * Validate an invitation token: check it exists, is pending, and not expired.
 * Throws coded errors for the handleTransactionError map.
 */
async function validateInvitationToken(token: string, session: mongoose.ClientSession): Promise<InvitationDocument> {
  const invitation = await Invitation.findOne({ token }).session(session);
  if (!invitation) throw new Error('INVITATION_NOT_FOUND');
  if (invitation.status !== 'pending') throw new Error(`INVITATION_${invitation.status.toUpperCase()}`);

  if (invitation.isExpired()) {
    invitation.status = 'expired';
    await invitation.save({ session });
    throw new Error('INVITATION_EXPIRED');
  }

  return invitation;
}

/**
 * Shared logic for accepting an invitation: creates UserOrganization membership,
 * sets lastActiveOrgId if needed, marks invitation as accepted, and notifies the inviter.
 * @param invitation - The invitation document being accepted
 * @param user - The user accepting the invitation
 * @param org - The target organization
 * @param acceptedVia - How the invitation was accepted ('email' or an OAuth provider)
 * @param session - Active Mongoose transaction session
 */
async function processInvitationAcceptance(
  invitation: InvitationDocument,
  user: UserDocument,
  org: OrganizationDocument,
  acceptedVia: 'email' | InvitationOAuthProvider,
  session: mongoose.ClientSession,
): Promise<void> {
  // Create the membership record with appropriate role
  const memberRole = invitation.role === 'admin' ? 'admin' : 'member';
  await UserOrganization.create([{
    userId: user._id,
    organizationId: org._id,
    role: memberRole,
  }], { session });

  // Set lastActiveOrgId if the user doesn't have one yet
  if (!user.lastActiveOrgId) {
    user.lastActiveOrgId = org._id;
    await user.save({ session });
  }

  invitation.status = 'accepted';
  invitation.acceptedAt = new Date();
  invitation.acceptedBy = user._id;
  invitation.acceptedVia = acceptedVia;
  await invitation.save({ session });

  await notifyInviter(invitation, user, org, session);
}

// Send Invitation

/**
 * Send invitation to join organization
 * POST /invitation/send
 */
export const sendInvitation = withController('Send invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const body = validateBody(sendInvitationSchema, req.body, res);
  if (!body) return;

  const session = await mongoose.startSession();

  try {
    const { email, role, invitationType, allowedOAuthProviders } = body;
    const inviterId = req.user!.sub;

    const result = await session.withTransaction(async () => {
      const org = await Organization.findById(orgId).session(session);
      if (!org) throw new Error('ORGANIZATION_NOT_FOUND');

      if (org.owner.toString() !== inviterId && req.user?.role !== 'admin') {
        throw new Error('UNAUTHORIZED');
      }

      // Check if user is already a member via UserOrganization
      const existingUser = await User.findOne({ email: email.toLowerCase() }).session(session);
      if (existingUser) {
        const existingMembership = await UserOrganization.findOne({
          userId: existingUser._id,
          organizationId: orgId,
        }).session(session);
        if (existingMembership) {
          throw new Error('ALREADY_MEMBER');
        }
      }

      const existingInvitation = await Invitation.findOne({
        email: email.toLowerCase(),
        organizationId: orgId,
        status: 'pending',
      }).session(session);

      if (existingInvitation && !existingInvitation.isExpired()) {
        throw new Error('INVITATION_ALREADY_SENT');
      }

      const pendingCount = await Invitation.countDocuments({ organizationId: orgId, status: 'pending' }).session(session);
      if (pendingCount >= config.invitation.maxPendingPerOrg) {
        throw new Error('MAX_INVITATIONS_REACHED');
      }

      if (existingInvitation) {
        existingInvitation.status = 'expired';
        await existingInvitation.save({ session });
      }

      const invitationData: Record<string, unknown> = {
        email: email.toLowerCase(),
        organizationId: orgId,
        invitedBy: inviterId,
        role,
        expiresAt: getExpirationDate(),
        invitationType,
      };

      if (allowedOAuthProviders && invitationType !== 'email') {
        invitationData.allowedOAuthProviders = allowedOAuthProviders;
      }

      const [invitation] = await Invitation.create([invitationData], { session });

      const inviter = await User.findById(inviterId).session(session);
      if (!inviter) throw new Error('INVITER_NOT_FOUND');

      const emailSent = await emailService.sendInvitation({
        recipientEmail: email.toLowerCase(),
        inviterName: inviter.username,
        organizationName: org.name,
        invitationToken: invitation.token,
        expiresAt: invitation.expiresAt,
        role,
        invitationType,
        allowedOAuthProviders: invitation.allowedOAuthProviders,
      });

      if (!emailSent && config.email.enabled) {
        logger.warn('Failed to send invitation email, but invitation created', { invitationId: invitation._id, email });
      }

      return invitation;
    });

    logger.info('[SEND INVITATION] Invitation sent', {
      invitationId: result?._id,
      email,
      organizationId: orgId,
      role,
      invitationType,
    });

    sendSuccess(res, 201, {
      invitation: {
        id: result?._id,
        email: result?.email,
        role: result?.role,
        status: result?.status,
        expiresAt: result?.expiresAt,
        invitationType: result?.invitationType,
        allowedOAuthProviders: result?.allowedOAuthProviders,
      },
    }, 'Invitation sent successfully');
  } finally {
    await session.endSession();
  }
}, {
  ORGANIZATION_NOT_FOUND: { status: 404, message: 'Organization not found' },
  UNAUTHORIZED: { status: 403, message: 'You are not authorized to send invitations' },
  ALREADY_MEMBER: { status: 400, message: 'User is already a member of this organization' },
  INVITATION_ALREADY_SENT: { status: 400, message: 'An invitation has already been sent to this email' },
  MAX_INVITATIONS_REACHED: { status: 400, message: 'Maximum pending invitations reached' },
  INVITER_NOT_FOUND: { status: 404, message: 'Inviter not found' },
});

// Accept Invitation

/**
 * Accept invitation (supports both email/password and OAuth)
 * POST /invitation/accept
 */
export const acceptInvitation = withController('Accept invitation', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return sendError(res, 400, 'Invitation token is required');
  }

  if (!req.user) {
    return sendError(res, 401, 'You must be logged in to accept an invitation');
  }

  const session = await mongoose.startSession();

  try {
    const oauthProvider = req.headers['x-oauth-provider'] as InvitationOAuthProvider | undefined;

    await session.withTransaction(async () => {
      const invitation = await validateInvitationToken(token, session);

      if (oauthProvider) {
        if (!invitation.canAcceptViaOAuth(oauthProvider)) throw new Error('OAUTH_NOT_ALLOWED');
      } else {
        if (!invitation.canAcceptViaEmail()) throw new Error('EMAIL_NOT_ALLOWED');
      }

      const user = await User.findById(req.user!.sub).session(session);
      if (!user) throw new Error('USER_NOT_FOUND');
      if (user.email !== invitation.email) throw new Error('EMAIL_MISMATCH');

      const org = await Organization.findById(invitation.organizationId).session(session);
      if (!org) throw new Error('ORGANIZATION_NOT_FOUND');

      // Check if already a member via UserOrganization
      const existingMembership = await UserOrganization.findOne({
        userId: user._id,
        organizationId: org._id,
      }).session(session);

      if (existingMembership) {
        invitation.status = 'accepted';
        invitation.acceptedAt = new Date();
        invitation.acceptedBy = user._id;
        invitation.acceptedVia = oauthProvider || 'email';
        await invitation.save({ session });
        throw new Error('ALREADY_MEMBER');
      }

      await processInvitationAcceptance(invitation, user, org, oauthProvider || 'email', session);

      logger.info('[ACCEPT INVITATION] Invitation accepted', {
        invitationId: invitation._id,
        userId: user._id,
        organizationId: org._id,
        acceptedVia: invitation.acceptedVia,
      });
    });

    sendSuccess(res, 200, undefined, 'Invitation accepted successfully');
  } finally {
    await session.endSession();
  }
}, {
  INVITATION_NOT_FOUND: { status: 404, message: 'Invitation not found' },
  INVITATION_ACCEPTED: { status: 400, message: 'Invitation has already been accepted' },
  INVITATION_EXPIRED: { status: 400, message: 'Invitation has expired' },
  INVITATION_REVOKED: { status: 400, message: 'Invitation has been revoked' },
  USER_NOT_FOUND: { status: 404, message: 'User not found' },
  EMAIL_MISMATCH: { status: 403, message: 'This invitation was sent to a different email address' },
  ORGANIZATION_NOT_FOUND: { status: 404, message: 'Organization not found' },
  ALREADY_MEMBER: { status: 400, message: 'You are already a member of this organization' },
  OAUTH_NOT_ALLOWED: { status: 403, message: 'This invitation cannot be accepted via OAuth' },
  EMAIL_NOT_ALLOWED: { status: 403, message: 'This invitation can only be accepted via OAuth' },
});

/**
 * Accept invitation via OAuth (creates user if needed)
 * POST /invitation/accept-oauth
 */
export const acceptInvitationViaOAuth = withController('Accept invitation via OAuth', async (req, res) => {
  const { token, oauthProvider, oauthData } = req.body;

  if (!token) return sendError(res, 400, 'Invitation token is required');
  if (!oauthProvider || !['google'].includes(oauthProvider)) {
    return sendError(res, 400, 'Valid OAuth provider is required');
  }
  if (!oauthData || !oauthData.id || !oauthData.email) {
    return sendError(res, 400, 'OAuth data with id and email is required');
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const invitation = await validateInvitationToken(token, session);

      if (!invitation.canAcceptViaOAuth(oauthProvider)) throw new Error('OAUTH_NOT_ALLOWED');
      if (oauthData.email.toLowerCase() !== invitation.email) throw new Error('EMAIL_MISMATCH');

      let user = await User.findOne({
        $or: [{ [`oauth.${oauthProvider}.id`]: oauthData.id }, { email: oauthData.email.toLowerCase() }],
      }).session(session);

      if (!user) {
        user = new User({
          email: oauthData.email.toLowerCase(),
          username: oauthData.email.split('@')[0],
          isEmailVerified: true,
          tokenVersion: 0,
          oauth: {
            [oauthProvider]: {
              id: oauthData.id,
              email: oauthData.email,
              name: oauthData.name,
              picture: oauthData.picture,
              linkedAt: new Date(),
            },
          },
        });
        await user.save({ session });
      } else if (!user.oauth?.[oauthProvider as keyof typeof user.oauth]) {
        await User.findByIdAndUpdate(user._id, {
          $set: {
            [`oauth.${oauthProvider}`]: {
              id: oauthData.id,
              email: oauthData.email,
              name: oauthData.name,
              picture: oauthData.picture,
              linkedAt: new Date(),
            },
          },
        }, { session });
      }

      const org = await Organization.findById(invitation.organizationId).session(session);
      if (!org) throw new Error('ORGANIZATION_NOT_FOUND');

      // Check if already a member via UserOrganization
      const existingMembership = await UserOrganization.findOne({
        userId: user._id,
        organizationId: org._id,
      }).session(session);

      if (existingMembership) {
        invitation.status = 'accepted';
        invitation.acceptedAt = new Date();
        invitation.acceptedBy = user._id;
        invitation.acceptedVia = oauthProvider;
        await invitation.save({ session });
        throw new Error('ALREADY_MEMBER');
      }

      await processInvitationAcceptance(invitation, user, org, oauthProvider, session);

      logger.info('[ACCEPT INVITATION VIA OAUTH] Invitation accepted', {
        invitationId: invitation._id,
        userId: user._id,
        organizationId: org._id,
        oauthProvider,
      });
    });

    sendSuccess(res, 200, undefined, 'Invitation accepted successfully via OAuth');
  } finally {
    await session.endSession();
  }
}, {
  INVITATION_NOT_FOUND: { status: 404, message: 'Invitation not found' },
  INVITATION_ACCEPTED: { status: 400, message: 'Invitation has already been accepted' },
  INVITATION_EXPIRED: { status: 400, message: 'Invitation has expired' },
  INVITATION_REVOKED: { status: 400, message: 'Invitation has been revoked' },
  EMAIL_MISMATCH: { status: 403, message: 'OAuth email does not match invitation email' },
  ORGANIZATION_NOT_FOUND: { status: 404, message: 'Organization not found' },
  ALREADY_MEMBER: { status: 400, message: 'You are already a member of this organization' },
  OAUTH_NOT_ALLOWED: { status: 403, message: 'This invitation cannot be accepted via OAuth' },
});

// Get/List/Manage Invitations

/**
 * Get invitation details by token (public - for preview before accepting)
 * GET /invitation/:token
 */
export const getInvitation = withController('Get invitation', async (req, res) => {
  const { token } = req.params;

  if (!token) {
    return sendError(res, 400, 'Invitation token is required');
  }

  const invitation = await Invitation.findOne({ token })
    .populate('organizationId', 'name slug')
    .populate('invitedBy', 'username');

  if (!invitation) {
    return sendError(res, 404, 'Invitation not found');
  }

  if (invitation.status === 'pending' && invitation.isExpired()) {
    invitation.status = 'expired';
    await invitation.save();
  }

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

/**
 * List organization invitations
 * GET /invitation/list
 */
export const listInvitations = withController('List invitations', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const { status, invitationType } = req.query;
  const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);

  const query: Record<string, unknown> = { organizationId: orgId };
  if (status && ['pending', 'accepted', 'expired', 'revoked'].includes(status as string)) {
    query.status = status;
  }
  if (invitationType && ['email', 'oauth', 'any'].includes(invitationType as string)) {
    query.invitationType = invitationType;
  }

  const [invitations, total] = await Promise.all([
    Invitation.find(query)
      .populate('invitedBy', 'username email')
      .populate('acceptedBy', 'username email')
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limitNum)
      .lean(),
    Invitation.countDocuments(query),
  ]);

  sendSuccess(res, 200, {
    invitations,
    pagination: { total, offset, limit: limitNum, hasMore: offset + limitNum < total },
  });
});

/**
 * Revoke invitation
 * DELETE /invitation/:invitationId
 */
export const revokeInvitation = withController('Revoke invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const { invitationId } = req.params;

  const invitation = await Invitation.findOne({ _id: invitationId, organizationId: orgId });
  if (!invitation) {
    return sendError(res, 404, 'Invitation not found');
  }

  if (invitation.status !== 'pending') {
    return sendError(res, 400, `Cannot revoke invitation with status: ${invitation.status}`);
  }

  const org = await Organization.findById(orgId);
  if (!org || (org.owner.toString() !== req.user!.sub && req.user!.role !== 'admin')) {
    return sendError(res, 403, 'You are not authorized to revoke invitations');
  }

  invitation.status = 'revoked';
  await invitation.save();

  logger.info('[REVOKE INVITATION] Invitation revoked', { invitationId, revokedBy: req.user!.sub });

  sendSuccess(res, 200, undefined, 'Invitation revoked successfully');
});

/**
 * Resend invitation email
 * POST /invitation/:invitationId/resend
 */
export const resendInvitation = withController('Resend invitation', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const { invitationId } = req.params;

  const invitation = await Invitation.findOne({ _id: invitationId, organizationId: orgId, status: 'pending' });
  if (!invitation) {
    return sendError(res, 404, 'Pending invitation not found');
  }

  const org = await Organization.findById(orgId);
  if (!org || (org.owner.toString() !== req.user!.sub && req.user!.role !== 'admin')) {
    return sendError(res, 403, 'You are not authorized to resend invitations');
  }

  const inviter = await User.findById(invitation.invitedBy);
  if (!inviter) {
    return sendError(res, 404, 'Inviter not found');
  }

  invitation.expiresAt = getExpirationDate();
  await invitation.save();

  const emailSent = await emailService.sendInvitation({
    recipientEmail: invitation.email,
    inviterName: inviter.username,
    organizationName: org.name,
    invitationToken: invitation.token,
    expiresAt: invitation.expiresAt,
    role: invitation.role,
    invitationType: invitation.invitationType,
    allowedOAuthProviders: invitation.allowedOAuthProviders,
  });

  if (!emailSent && config.email.enabled) {
    return sendError(res, 500, 'Failed to send invitation email');
  }

  logger.info('[RESEND INVITATION] Invitation resent', { invitationId, email: invitation.email });

  sendSuccess(res, 200, { expiresAt: invitation.expiresAt }, 'Invitation resent successfully');
});
