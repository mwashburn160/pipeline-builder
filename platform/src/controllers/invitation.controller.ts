import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config';
import { Invitation, Organization, User } from '../models';
import { InvitationOAuthProvider } from '../models/invitation.model';
import {
  logger,
  sendError,
  ErrorCode,
  HttpStatus,
  emailService,
} from '../utils';

/**
 * Send invitation to join organization
 * POST /invitation/send
 */
export async function sendInvitation(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const {
      email,
      role = 'user',
      invitationType = 'any',
      allowedOAuthProviders,
    } = req.body;

    const organizationId = req.user.organizationId;
    const inviterId = req.user.sub;

    if (!organizationId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization to send invitations', ErrorCode.INVALID_INPUT);
    }

    if (!email) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Email is required', ErrorCode.INVALID_INPUT);
    }

    if (!['user', 'admin'].includes(role)) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Invalid role. Must be "user" or "admin"', ErrorCode.INVALID_INPUT);
    }

    if (!['email', 'oauth', 'any'].includes(invitationType)) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Invalid invitation type. Must be "email", "oauth", or "any"', ErrorCode.INVALID_INPUT);
    }

    // Validate OAuth providers if specified
    if (allowedOAuthProviders && Array.isArray(allowedOAuthProviders)) {
      const validProviders = ['google', 'github', 'microsoft'];
      const invalidProviders = allowedOAuthProviders.filter(p => !validProviders.includes(p));
      if (invalidProviders.length > 0) {
        return sendError(res, HttpStatus.BAD_REQUEST, `Invalid OAuth providers: ${invalidProviders.join(', ')}`);
      }
    }

    const result = await session.withTransaction(async () => {
      // Get organization and verify requester is owner/admin
      const org = await Organization.findById(organizationId).session(session);
      if (!org) {
        throw new Error('ORGANIZATION_NOT_FOUND');
      }

      // Only owner can send invitations (or admins if you want to change this)
      if (org.owner.toString() !== inviterId && !req.user?.isAdmin) {
        throw new Error('UNAUTHORIZED');
      }

      // Check if user already exists and is a member
      const existingUser = await User.findOne({ email: email.toLowerCase() }).session(session);
      if (existingUser) {
        const isMember = org.members.some(id => id.toString() === existingUser._id.toString());
        if (isMember) {
          throw new Error('ALREADY_MEMBER');
        }
      }

      // Check for existing pending invitation
      const existingInvitation = await Invitation.findOne({
        email: email.toLowerCase(),
        organizationId,
        status: 'pending',
      }).session(session);

      if (existingInvitation && !existingInvitation.isExpired()) {
        throw new Error('INVITATION_ALREADY_SENT');
      }

      // Check max pending invitations per org
      const pendingCount = await Invitation.countDocuments({
        organizationId,
        status: 'pending',
      }).session(session);

      if (pendingCount >= config.invitation.maxPendingPerOrg) {
        throw new Error('MAX_INVITATIONS_REACHED');
      }

      // Expire old invitation if exists
      if (existingInvitation) {
        existingInvitation.status = 'expired';
        await existingInvitation.save({ session });
      }

      // Create new invitation
      const expiresAt = new Date(
        Date.now() + config.invitation.expirationDays * 24 * 60 * 60 * 1000,
      );

      const invitationData: any = {
        email: email.toLowerCase(),
        organizationId,
        invitedBy: inviterId,
        role,
        expiresAt,
        invitationType,
      };

      // Only set allowedOAuthProviders if specified and invitation type supports OAuth
      if (allowedOAuthProviders && invitationType !== 'email') {
        invitationData.allowedOAuthProviders = allowedOAuthProviders;
      }

      const [invitation] = await Invitation.create([invitationData], { session });

      // Get inviter details for email
      const inviter = await User.findById(inviterId).session(session);
      if (!inviter) {
        throw new Error('INVITER_NOT_FOUND');
      }

      // Send invitation email
      const emailSent = await emailService.sendInvitation({
        recipientEmail: email.toLowerCase(),
        inviterName: inviter.username,
        organizationName: org.name,
        invitationToken: invitation.token,
        expiresAt,
        role,
        invitationType,
        allowedOAuthProviders: invitation.allowedOAuthProviders,
      });

      if (!emailSent && config.email.enabled) {
        logger.warn('Failed to send invitation email, but invitation created', {
          invitationId: invitation._id,
          email,
        });
      }

      return invitation;
    });

    logger.info('[SEND INVITATION] Invitation sent', {
      invitationId: result?._id,
      email,
      organizationId,
      role,
      invitationType,
    });

    res.status(201).json({
      success: true,
      statusCode: 201,
      message: 'Invitation sent successfully',
      invitation: {
        id: result?._id,
        email: result?.email,
        role: result?.role,
        status: result?.status,
        expiresAt: result?.expiresAt,
        invitationType: result?.invitationType,
        allowedOAuthProviders: result?.allowedOAuthProviders,
      },
    });
  } catch (err: any) {
    logger.error('[SEND INVITATION] Failed:', err);

    const errorMap: Record<string, { status: number; message: string }> = {
      ORGANIZATION_NOT_FOUND: { status: 404, message: 'Organization not found' },
      UNAUTHORIZED: { status: 403, message: 'You are not authorized to send invitations' },
      ALREADY_MEMBER: { status: 400, message: 'User is already a member of this organization' },
      INVITATION_ALREADY_SENT: { status: 400, message: 'An invitation has already been sent to this email' },
      MAX_INVITATIONS_REACHED: { status: 400, message: 'Maximum pending invitations reached' },
      INVITER_NOT_FOUND: { status: 404, message: 'Inviter not found' },
    };

    const error = errorMap[err.message] || { status: 500, message: 'Failed to send invitation' };
    return sendError(res, error.status, error.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Accept invitation (supports both email/password and OAuth)
 * POST /invitation/accept
 */
export async function acceptInvitation(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    const { token } = req.body;

    if (!token) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Invitation token is required', ErrorCode.INVALID_INPUT);
    }

    // User must be authenticated to accept
    if (!req.user) {
      return sendError(res, 401, 'You must be logged in to accept an invitation');
    }

    // Determine if this is an OAuth acceptance
    const oauthProvider = req.headers['x-oauth-provider'] as InvitationOAuthProvider | undefined;

    await session.withTransaction(async () => {
      // Find invitation
      const invitation = await Invitation.findOne({ token }).session(session);

      if (!invitation) {
        throw new Error('INVITATION_NOT_FOUND');
      }

      if (invitation.status !== 'pending') {
        throw new Error(`INVITATION_${invitation.status.toUpperCase()}`);
      }

      if (invitation.isExpired()) {
        invitation.status = 'expired';
        await invitation.save({ session });
        throw new Error('INVITATION_EXPIRED');
      }

      // Validate acceptance method
      if (oauthProvider) {
        if (!invitation.canAcceptViaOAuth(oauthProvider)) {
          throw new Error('OAUTH_NOT_ALLOWED');
        }
      } else {
        if (!invitation.canAcceptViaEmail()) {
          throw new Error('EMAIL_NOT_ALLOWED');
        }
      }

      // Get user
      const user = await User.findById(req.user!.sub).session(session);
      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      // Verify email matches (optional - you may want to allow any authenticated user)
      if (user.email !== invitation.email) {
        throw new Error('EMAIL_MISMATCH');
      }

      // Check if already a member
      const org = await Organization.findById(invitation.organizationId).session(session);
      if (!org) {
        throw new Error('ORGANIZATION_NOT_FOUND');
      }

      const isMember = org.members.some(id => id.toString() === user._id.toString());
      if (isMember) {
        invitation.status = 'accepted';
        invitation.acceptedAt = new Date();
        invitation.acceptedBy = user._id;
        invitation.acceptedVia = oauthProvider || 'email';
        await invitation.save({ session });
        throw new Error('ALREADY_MEMBER');
      }

      // Add user to organization
      org.members.push(user._id);
      await org.save({ session });

      // Update user's organization and role
      user.organizationId = org._id;
      if (invitation.role === 'admin') {
        user.role = 'admin';
      }
      await user.save({ session });

      // Mark invitation as accepted
      invitation.status = 'accepted';
      invitation.acceptedAt = new Date();
      invitation.acceptedBy = user._id;
      invitation.acceptedVia = oauthProvider || 'email';
      await invitation.save({ session });

      // Notify inviter
      const inviter = await User.findById(invitation.invitedBy).session(session);
      if (inviter) {
        emailService.sendInvitationAccepted(
          inviter.email,
          inviter.username,
          user.username,
          org.name,
        ).catch(err => logger.error('Failed to send acceptance notification:', err));
      }

      logger.info('[ACCEPT INVITATION] Invitation accepted', {
        invitationId: invitation._id,
        userId: user._id,
        organizationId: org._id,
        acceptedVia: invitation.acceptedVia,
      });
    });

    res.json({
      success: true,
      statusCode: 200,
      message: 'Invitation accepted successfully',
    });
  } catch (err: any) {
    logger.error('[ACCEPT INVITATION] Failed:', err);

    const errorMap: Record<string, { status: number; message: string }> = {
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
    };

    const error = errorMap[err.message] || { status: 500, message: 'Failed to accept invitation' };
    return sendError(res, error.status, error.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Accept invitation via OAuth (creates user if needed)
 * POST /invitation/accept-oauth
 */
export async function acceptInvitationViaOAuth(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    const { token, oauthProvider, oauthData } = req.body;

    if (!token) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Invitation token is required', ErrorCode.INVALID_INPUT);
    }

    if (!oauthProvider || !['google', 'github', 'microsoft'].includes(oauthProvider)) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Valid OAuth provider is required', ErrorCode.INVALID_INPUT);
    }

    if (!oauthData || !oauthData.id || !oauthData.email) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'OAuth data with id and email is required', ErrorCode.INVALID_INPUT);
    }

    await session.withTransaction(async () => {
      // Find invitation
      const invitation = await Invitation.findOne({ token }).session(session);

      if (!invitation) {
        throw new Error('INVITATION_NOT_FOUND');
      }

      if (invitation.status !== 'pending') {
        throw new Error(`INVITATION_${invitation.status.toUpperCase()}`);
      }

      if (invitation.isExpired()) {
        invitation.status = 'expired';
        await invitation.save({ session });
        throw new Error('INVITATION_EXPIRED');
      }

      // Validate OAuth acceptance is allowed
      if (!invitation.canAcceptViaOAuth(oauthProvider)) {
        throw new Error('OAUTH_NOT_ALLOWED');
      }

      // Verify email matches invitation
      if (oauthData.email.toLowerCase() !== invitation.email) {
        throw new Error('EMAIL_MISMATCH');
      }

      // Find or create user
      let user = await User.findOne({
        $or: [
          { [`oauth.${oauthProvider}.id`]: oauthData.id },
          { email: oauthData.email.toLowerCase() },
        ],
      }).session(session);

      if (!user) {
        // Create new user with OAuth
        user = new User({
          email: oauthData.email.toLowerCase(),
          username: oauthData.email.split('@')[0],
          isEmailVerified: true, // OAuth emails are pre-verified
          role: 'user',
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
        // Link OAuth provider to existing user
        await User.findByIdAndUpdate(
          user._id,
          {
            $set: {
              [`oauth.${oauthProvider}`]: {
                id: oauthData.id,
                email: oauthData.email,
                name: oauthData.name,
                picture: oauthData.picture,
                linkedAt: new Date(),
              },
            },
          },
          { session },
        );
      }

      // Check if already a member
      const org = await Organization.findById(invitation.organizationId).session(session);
      if (!org) {
        throw new Error('ORGANIZATION_NOT_FOUND');
      }

      const isMember = org.members.some(id => id.toString() === user!._id.toString());
      if (isMember) {
        invitation.status = 'accepted';
        invitation.acceptedAt = new Date();
        invitation.acceptedBy = user._id;
        invitation.acceptedVia = oauthProvider;
        await invitation.save({ session });
        throw new Error('ALREADY_MEMBER');
      }

      // Add user to organization
      org.members.push(user._id);
      await org.save({ session });

      // Update user's organization and role
      user.organizationId = org._id;
      if (invitation.role === 'admin') {
        user.role = 'admin';
      }
      await user.save({ session });

      // Mark invitation as accepted
      invitation.status = 'accepted';
      invitation.acceptedAt = new Date();
      invitation.acceptedBy = user._id;
      invitation.acceptedVia = oauthProvider;
      await invitation.save({ session });

      // Notify inviter
      const inviter = await User.findById(invitation.invitedBy).session(session);
      if (inviter) {
        emailService.sendInvitationAccepted(
          inviter.email,
          inviter.username,
          user.username,
          org.name,
        ).catch(err => logger.error('Failed to send acceptance notification:', err));
      }

      logger.info('[ACCEPT INVITATION VIA OAUTH] Invitation accepted', {
        invitationId: invitation._id,
        userId: user._id,
        organizationId: org._id,
        oauthProvider,
      });
    });

    res.json({
      success: true,
      statusCode: 200,
      message: 'Invitation accepted successfully via OAuth',
    });
  } catch (err: any) {
    logger.error('[ACCEPT INVITATION VIA OAUTH] Failed:', err);

    const errorMap: Record<string, { status: number; message: string }> = {
      INVITATION_NOT_FOUND: { status: 404, message: 'Invitation not found' },
      INVITATION_ACCEPTED: { status: 400, message: 'Invitation has already been accepted' },
      INVITATION_EXPIRED: { status: 400, message: 'Invitation has expired' },
      INVITATION_REVOKED: { status: 400, message: 'Invitation has been revoked' },
      EMAIL_MISMATCH: { status: 403, message: 'OAuth email does not match invitation email' },
      ORGANIZATION_NOT_FOUND: { status: 404, message: 'Organization not found' },
      ALREADY_MEMBER: { status: 400, message: 'You are already a member of this organization' },
      OAUTH_NOT_ALLOWED: { status: 403, message: 'This invitation cannot be accepted via OAuth' },
    };

    const error = errorMap[err.message] || { status: 500, message: 'Failed to accept invitation' };
    return sendError(res, error.status, error.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Get invitation details by token (public - for preview before accepting)
 * GET /invitation/:token
 */
export async function getInvitation(req: Request, res: Response): Promise<void> {
  try {
    const { token } = req.params;

    if (!token) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Invitation token is required', ErrorCode.INVALID_INPUT);
    }

    const invitation = await Invitation.findOne({ token })
      .populate('organizationId', 'name slug')
      .populate('invitedBy', 'username');

    if (!invitation) {
      return sendError(res, HttpStatus.NOT_FOUND, 'Invitation not found', ErrorCode.NOT_FOUND);
    }

    // Check if expired and update status
    if (invitation.status === 'pending' && invitation.isExpired()) {
      invitation.status = 'expired';
      await invitation.save();
    }

    res.json({
      success: true,
      statusCode: 200,
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
        canAcceptViaGitHub: invitation.canAcceptViaOAuth('github'),
        canAcceptViaMicrosoft: invitation.canAcceptViaOAuth('microsoft'),
      },
    });
  } catch (err) {
    logger.error('[GET INVITATION] Failed:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to get invitation', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * List organization invitations
 * GET /invitation/list
 */
export async function listInvitations(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const organizationId = req.user.organizationId;
    if (!organizationId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization', ErrorCode.INVALID_INPUT);
    }

    const { status, invitationType, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query: any = { organizationId };
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
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Invitation.countDocuments(query),
    ]);

    res.json({
      success: true,
      statusCode: 200,
      invitations,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    logger.error('[LIST INVITATIONS] Failed:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to list invitations', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Revoke invitation
 * DELETE /invitation/:invitationId
 */
export async function revokeInvitation(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const { invitationId } = req.params;
    const organizationId = req.user.organizationId;

    if (!organizationId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization', ErrorCode.INVALID_INPUT);
    }

    const invitation = await Invitation.findOne({
      _id: invitationId,
      organizationId,
    });

    if (!invitation) {
      return sendError(res, HttpStatus.NOT_FOUND, 'Invitation not found', ErrorCode.NOT_FOUND);
    }

    if (invitation.status !== 'pending') {
      return sendError(res, HttpStatus.BAD_REQUEST, `Cannot revoke invitation with status: ${invitation.status}`);
    }

    // Verify requester is org owner or admin
    const org = await Organization.findById(organizationId);
    if (!org || (org.owner.toString() !== req.user.sub && !req.user.isAdmin)) {
      return sendError(res, HttpStatus.FORBIDDEN, 'You are not authorized to revoke invitations', ErrorCode.FORBIDDEN);
    }

    invitation.status = 'revoked';
    await invitation.save();

    logger.info('[REVOKE INVITATION] Invitation revoked', {
      invitationId,
      revokedBy: req.user.sub,
    });

    res.json({
      success: true,
      statusCode: 200,
      message: 'Invitation revoked successfully',
    });
  } catch (err) {
    logger.error('[REVOKE INVITATION] Failed:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to revoke invitation', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Resend invitation email
 * POST /invitation/:invitationId/resend
 */
export async function resendInvitation(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const { invitationId } = req.params;
    const organizationId = req.user.organizationId;

    if (!organizationId) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'You must belong to an organization', ErrorCode.INVALID_INPUT);
    }

    const invitation = await Invitation.findOne({
      _id: invitationId,
      organizationId,
      status: 'pending',
    });

    if (!invitation) {
      return sendError(res, HttpStatus.NOT_FOUND, 'Pending invitation not found', ErrorCode.NOT_FOUND);
    }

    // Verify requester is org owner or admin
    const org = await Organization.findById(organizationId);
    if (!org || (org.owner.toString() !== req.user.sub && !req.user.isAdmin)) {
      return sendError(res, HttpStatus.FORBIDDEN, 'You are not authorized to resend invitations', ErrorCode.FORBIDDEN);
    }

    const inviter = await User.findById(invitation.invitedBy);
    if (!inviter) {
      return sendError(res, HttpStatus.NOT_FOUND, 'Inviter not found', ErrorCode.NOT_FOUND);
    }

    // Extend expiration
    invitation.expiresAt = new Date(
      Date.now() + config.invitation.expirationDays * 24 * 60 * 60 * 1000,
    );
    await invitation.save();

    // Resend email
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
      return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to send invitation email', ErrorCode.INTERNAL_ERROR);
    }

    logger.info('[RESEND INVITATION] Invitation resent', {
      invitationId,
      email: invitation.email,
    });

    res.json({
      success: true,
      statusCode: 200,
      message: 'Invitation resent successfully',
      expiresAt: invitation.expiresAt,
    });
  } catch (err) {
    logger.error('[RESEND INVITATION] Failed:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to resend invitation', ErrorCode.INTERNAL_ERROR);
  }
}