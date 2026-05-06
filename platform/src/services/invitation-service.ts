// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config';
import { toOrgId } from '../helpers/controller-helper';
import { Invitation, InvitationDocument, Organization, OrganizationDocument, User, UserDocument, UserOrganization } from '../models';
import type { InvitationOAuthProvider } from '../models/invitation';
import { emailService } from '../utils/email';

const logger = createLogger('InvitationService');

/** Domain errors mapped to HTTP status by controllers via withController. */
export const INV_ORG_NOT_FOUND = 'INV_ORG_NOT_FOUND';
export const INV_UNAUTHORIZED = 'INV_UNAUTHORIZED';
export const INV_ALREADY_MEMBER = 'INV_ALREADY_MEMBER';
export const INV_ALREADY_SENT = 'INV_ALREADY_SENT';
export const INV_MAX_REACHED = 'INV_MAX_REACHED';
export const INV_INVITER_NOT_FOUND = 'INV_INVITER_NOT_FOUND';
export const INV_NOT_FOUND = 'INV_NOT_FOUND';
export const INV_ACCEPTED = 'INV_ACCEPTED';
export const INV_EXPIRED = 'INV_EXPIRED';
export const INV_REVOKED = 'INV_REVOKED';
export const INV_USER_NOT_FOUND = 'INV_USER_NOT_FOUND';
export const INV_EMAIL_MISMATCH = 'INV_EMAIL_MISMATCH';
export const INV_OAUTH_NOT_ALLOWED = 'INV_OAUTH_NOT_ALLOWED';
export const INV_EMAIL_NOT_ALLOWED = 'INV_EMAIL_NOT_ALLOWED';
export const INV_NOT_PENDING = 'INV_NOT_PENDING';

interface SendInvitationInput {
  orgId: string;
  inviterId: string;
  inviterIsAdmin: boolean;
  email: string;
  role: 'admin' | 'member';
  invitationType: 'email' | 'oauth' | 'any';
  allowedOAuthProviders?: InvitationOAuthProvider[];
}

interface SendInvitationResult {
  invitation: InvitationDocument;
  emailSent: boolean;
}

function getExpirationDate(): Date {
  return new Date(Date.now() + config.invitation.expirationDays * 24 * 60 * 60 * 1000);
}

class InvitationService {
  /**
   * Token validity check used by both accept paths. Marks expired invitations
   * as such on the way out (cheap GC). Throws INV_NOT_FOUND / INV_ACCEPTED /
   * INV_EXPIRED / INV_REVOKED.
   */
  private async validateToken(token: string, session: mongoose.ClientSession): Promise<InvitationDocument> {
    const invitation = await Invitation.findOne({ token }).session(session);
    if (!invitation) throw new Error(INV_NOT_FOUND);
    if (invitation.status !== 'pending') throw new Error(`INV_${invitation.status.toUpperCase()}`);
    if (invitation.isExpired()) {
      invitation.status = 'expired';
      await invitation.save({ session });
      throw new Error(INV_EXPIRED);
    }
    return invitation;
  }

  /** Common acceptance bookkeeping: create membership, set lastActiveOrgId, mark accepted, notify inviter. */
  private async processAcceptance(
    invitation: InvitationDocument,
    user: UserDocument,
    org: OrganizationDocument,
    acceptedVia: 'email' | InvitationOAuthProvider,
    session: mongoose.ClientSession,
  ): Promise<void> {
    const memberRole = invitation.role === 'admin' ? 'admin' : 'member';
    await UserOrganization.create([{
      userId: user._id, organizationId: org._id, role: memberRole,
    }], { session });

    if (!user.lastActiveOrgId) {
      user.lastActiveOrgId = org._id as mongoose.Types.ObjectId;
      await user.save({ session });
    }

    invitation.status = 'accepted';
    invitation.acceptedAt = new Date();
    invitation.acceptedBy = user._id;
    invitation.acceptedVia = acceptedVia;
    await invitation.save({ session });

    // Fire-and-forget acceptance notification to the inviter.
    const inviter = await User.findById(invitation.invitedBy).session(session);
    if (inviter) {
      emailService.sendInvitationAccepted(inviter.email, inviter.username, user.username, org.name)
        .catch(error => logger.error('Failed to send acceptance notification', { error }));
    }
  }

  /**
   * Send a new invitation to an email. Validates ownership/admin-ship,
   * detects existing membership + pending invitations, enforces the
   * per-org pending cap, and triggers the invitation email. Wrapped in a
   * single Mongo transaction so half-completed sends can't leak rows.
   */
  async send(input: SendInvitationInput): Promise<SendInvitationResult> {
    const session = await mongoose.startSession();
    try {
      let invitation!: InvitationDocument;
      let emailSent = false;

      await session.withTransaction(async () => {
        const org = await Organization.findById(input.orgId).session(session);
        if (!org) throw new Error(INV_ORG_NOT_FOUND);

        if (org.owner.toString() !== input.inviterId && !input.inviterIsAdmin) {
          throw new Error(INV_UNAUTHORIZED);
        }

        const existingUser = await User.findOne({ email: input.email.toLowerCase() }).session(session);
        if (existingUser) {
          const existingMembership = await UserOrganization.findOne({
            userId: existingUser._id, organizationId: toOrgId(input.orgId),
          }).session(session);
          if (existingMembership) throw new Error(INV_ALREADY_MEMBER);
        }

        const existingInvitation = await Invitation.findOne({
          email: input.email.toLowerCase(),
          organizationId: toOrgId(input.orgId),
          status: 'pending',
        }).session(session);

        if (existingInvitation && !existingInvitation.isExpired()) {
          throw new Error(INV_ALREADY_SENT);
        }

        const pendingCount = await Invitation.countDocuments({
          organizationId: toOrgId(input.orgId), status: 'pending',
        }).session(session);
        if (pendingCount >= config.invitation.maxPendingPerOrg) {
          throw new Error(INV_MAX_REACHED);
        }

        if (existingInvitation) {
          existingInvitation.status = 'expired';
          await existingInvitation.save({ session });
        }

        const data: Record<string, unknown> = {
          email: input.email.toLowerCase(),
          organizationId: toOrgId(input.orgId),
          invitedBy: input.inviterId,
          role: input.role,
          expiresAt: getExpirationDate(),
          invitationType: input.invitationType,
        };
        if (input.allowedOAuthProviders && input.invitationType !== 'email') {
          data.allowedOAuthProviders = input.allowedOAuthProviders;
        }

        const [created] = await Invitation.create([data], { session });
        invitation = created;

        const inviter = await User.findById(input.inviterId).session(session);
        if (!inviter) throw new Error(INV_INVITER_NOT_FOUND);

        emailSent = await emailService.sendInvitation({
          recipientEmail: input.email.toLowerCase(),
          inviterName: inviter.username,
          organizationName: org.name,
          invitationToken: invitation.token,
          expiresAt: invitation.expiresAt,
          role: input.role,
          invitationType: input.invitationType,
          allowedOAuthProviders: invitation.allowedOAuthProviders,
        });
      });

      return { invitation, emailSent };
    } finally {
      await session.endSession();
    }
  }

  /**
   * Accept an invitation as the currently-logged-in user. Verifies the
   * caller's email matches the invitee, that the OAuth/email accept method
   * is allowed by the invitation, and that they're not already a member.
   * Throws INV_USER_NOT_FOUND / INV_EMAIL_MISMATCH / INV_ALREADY_MEMBER /
   * etc. on the various failure cases.
   */
  async accept(token: string, userId: string, oauthProvider?: InvitationOAuthProvider): Promise<void> {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const invitation = await this.validateToken(token, session);

        if (oauthProvider) {
          if (!invitation.canAcceptViaOAuth(oauthProvider)) throw new Error(INV_OAUTH_NOT_ALLOWED);
        } else {
          if (!invitation.canAcceptViaEmail()) throw new Error(INV_EMAIL_NOT_ALLOWED);
        }

        const user = await User.findById(userId).session(session);
        if (!user) throw new Error(INV_USER_NOT_FOUND);
        if (user.email !== invitation.email) throw new Error(INV_EMAIL_MISMATCH);

        const org = await Organization.findById(invitation.organizationId).session(session);
        if (!org) throw new Error(INV_ORG_NOT_FOUND);

        const existingMembership = await UserOrganization.findOne({
          userId: user._id, organizationId: org._id,
        }).session(session);

        if (existingMembership) {
          // Mark the invitation accepted even though we don't create a new
          // membership — keeps the audit trail consistent.
          invitation.status = 'accepted';
          invitation.acceptedAt = new Date();
          invitation.acceptedBy = user._id;
          invitation.acceptedVia = oauthProvider || 'email';
          await invitation.save({ session });
          throw new Error(INV_ALREADY_MEMBER);
        }

        await this.processAcceptance(invitation, user, org, oauthProvider || 'email', session);
      });
    } finally {
      await session.endSession();
    }
  }

  /**
   * Accept an invitation via OAuth, creating the User if they don't exist
   * yet (and linking the OAuth identity if they do). Used by the
   * /invitation/accept-oauth endpoint when the invitee comes through
   * an OAuth provider for the first time.
   */
  async acceptViaOAuth(
    token: string,
    oauthProvider: InvitationOAuthProvider,
    oauthData: { id: string; email: string; name?: string; picture?: string },
  ): Promise<void> {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const invitation = await this.validateToken(token, session);

        if (!invitation.canAcceptViaOAuth(oauthProvider)) throw new Error(INV_OAUTH_NOT_ALLOWED);
        if (oauthData.email.toLowerCase() !== invitation.email) throw new Error(INV_EMAIL_MISMATCH);

        let user = await User.findOne({
          $or: [
            { [`oauth.${oauthProvider}.id`]: oauthData.id },
            { email: oauthData.email.toLowerCase() },
          ],
        }).session(session);

        if (!user) {
          user = new User({
            email: oauthData.email.toLowerCase(),
            username: oauthData.email.split('@')[0],
            isEmailVerified: true,
            tokenVersion: 0,
            oauth: { [oauthProvider]: { id: oauthData.id, email: oauthData.email, name: oauthData.name, picture: oauthData.picture, linkedAt: new Date() } },
          });
          await user.save({ session });
        } else if (!user.oauth?.[oauthProvider as keyof typeof user.oauth]) {
          await User.findByIdAndUpdate(user._id, {
            $set: { [`oauth.${oauthProvider}`]: { id: oauthData.id, email: oauthData.email, name: oauthData.name, picture: oauthData.picture, linkedAt: new Date() } },
          }, { session });
        }

        const org = await Organization.findById(invitation.organizationId).session(session);
        if (!org) throw new Error(INV_ORG_NOT_FOUND);

        const existingMembership = await UserOrganization.findOne({
          userId: user._id, organizationId: org._id,
        }).session(session);

        if (existingMembership) {
          invitation.status = 'accepted';
          invitation.acceptedAt = new Date();
          invitation.acceptedBy = user._id;
          invitation.acceptedVia = oauthProvider;
          await invitation.save({ session });
          throw new Error(INV_ALREADY_MEMBER);
        }

        await this.processAcceptance(invitation, user, org, oauthProvider, session);
      });
    } finally {
      await session.endSession();
    }
  }

  /**
   * Public preview by token — also opportunistically marks the invitation
   * expired if the TTL has lapsed. Returns a partial-shape invitation with
   * `isValid` / `canAcceptVia*` derived for the frontend.
   */
  async getByToken(token: string) {
    const invitation = await Invitation.findOne({ token })
      .populate('organizationId', 'name slug')
      .populate('invitedBy', 'username');
    if (!invitation) return null;

    if (invitation.status === 'pending' && invitation.isExpired()) {
      invitation.status = 'expired';
      await invitation.save();
    }

    return invitation;
  }

  /**
   * List invitations for an org with optional status / type filters and
   * pagination. Populates the invitedBy + acceptedBy user references for
   * the dashboard's "who invited whom" UI.
   */
  async listForOrg(orgId: string, opts: {
    status?: string;
    invitationType?: string;
    offset: number;
    limit: number;
  }) {
    const query: Record<string, unknown> = { organizationId: toOrgId(orgId) };
    if (opts.status && ['pending', 'accepted', 'expired', 'revoked'].includes(opts.status)) {
      query.status = opts.status;
    }
    if (opts.invitationType && ['email', 'oauth', 'any'].includes(opts.invitationType)) {
      query.invitationType = opts.invitationType;
    }

    const [invitations, total] = await Promise.all([
      Invitation.find(query)
        .populate('invitedBy', 'username email')
        .populate('acceptedBy', 'username email')
        .sort({ createdAt: -1 })
        .skip(opts.offset)
        .limit(opts.limit)
        .lean(),
      Invitation.countDocuments(query),
    ]);

    return { invitations, total };
  }

  /**
   * Revoke a pending invitation. Verifies the caller is the org owner or
   * a system admin. Throws INV_NOT_FOUND / INV_NOT_PENDING / INV_UNAUTHORIZED.
   */
  async revoke(invitationId: string, orgId: string, userId: string, isAdmin: boolean): Promise<void> {
    const invitation = await Invitation.findOne({ _id: invitationId, organizationId: toOrgId(orgId) });
    if (!invitation) throw new Error(INV_NOT_FOUND);
    if (invitation.status !== 'pending') throw new Error(INV_NOT_PENDING);

    const org = await Organization.findById(orgId);
    if (!org || (org.owner.toString() !== userId && !isAdmin)) {
      throw new Error(INV_UNAUTHORIZED);
    }

    invitation.status = 'revoked';
    await invitation.save();
  }

  /**
   * Re-send an invitation email and reset its expiry. Verifies caller
   * authz against the org. Returns the new expiry + whether the email
   * actually sent (false → caller can decide to surface a 500 if email
   * is required).
   */
  async resend(invitationId: string, orgId: string, userId: string, isAdmin: boolean): Promise<{ expiresAt: Date; emailSent: boolean }> {
    const invitation = await Invitation.findOne({
      _id: invitationId, organizationId: toOrgId(orgId), status: 'pending',
    });
    if (!invitation) throw new Error(INV_NOT_FOUND);

    const org = await Organization.findById(orgId);
    if (!org || (org.owner.toString() !== userId && !isAdmin)) {
      throw new Error(INV_UNAUTHORIZED);
    }

    const inviter = await User.findById(invitation.invitedBy);
    if (!inviter) throw new Error(INV_INVITER_NOT_FOUND);

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

    return { expiresAt: invitation.expiresAt, emailSent };
  }
}

export const invitationService = new InvitationService();
