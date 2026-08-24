// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { assignBuiltinAdminRole, ensureBaselineRole, recomputeUserOrgRole } from './roles-service.js';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/controller-helper.js';
import { seatCapacityAvailable, seatCapacityStillWithinCap } from '../helpers/seats.js';
import { Invitation, type InvitationDocument, Organization, type OrganizationDocument, User, type UserDocument, UserOrganization } from '../models/index.js';
import type { InvitationOAuthProvider } from '../models/invitation.js';
import { emailService } from '../utils/email.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { escapeRegex } from '../utils/regex.js';

const logger = createLogger('invitation-service');

/** Domain errors mapped to HTTP status by controllers via withController. */
export const INV_ORG_NOT_FOUND = 'INV_ORG_NOT_FOUND';
export const INV_UNAUTHORIZED = 'INV_UNAUTHORIZED';
export const INV_ALREADY_MEMBER = 'INV_ALREADY_MEMBER';
export const INV_ALREADY_SENT = 'INV_ALREADY_SENT';
export const INV_MAX_REACHED = 'INV_MAX_REACHED';
export const INV_SEAT_LIMIT = 'INV_SEAT_LIMIT';
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

/** Minimal, secret-free invitation facts the controllers surface into audit
 *  events. NEVER carries the invitation TOKEN — email + role + ids only. */
export interface InvitationAuditInfo {
  invitationId: string;
  organizationId: string;
  email: string;
  role: string;
}

/** {@link InvitationAuditInfo} plus the id of the user who accepted — resolved
 *  server-side on the OAuth-accept path where there is no `req.user`. */
export interface InvitationAcceptResult extends InvitationAuditInfo {
  userId: string;
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

    // Single-source RBAC: a role-less membership resolves to ZERO permissions, so
    // give EVERY membership the built-in Member Role floor. An ADMIN invitee ALSO
    // gets the built-in Admin Role so their effective PERMISSIONS match the coarse
    // role — setting `membership.role='admin'` alone yields coarse-admin/zero-perms
    // and is reverted by the next recomputeUserOrgRole. We assign Roles and let
    // recompute DERIVE the cached role (mirrors user-admin-service.createUser).
    await ensureBaselineRole(user._id, org._id, session);
    if (memberRole === 'admin') {
      await assignBuiltinAdminRole(user._id, org._id, session);
      await recomputeUserOrgRole(user._id, org._id, session);
    }

    if (!user.lastActiveOrgId) {
      user.lastActiveOrgId = String(org._id);
      await user.save({ session });
    }

    invitation.status = 'accepted';
    invitation.acceptedAt = new Date();
    invitation.acceptedBy = user._id;
    invitation.acceptedVia = acceptedVia;
    await invitation.save({ session });

    // Seat capacity is enforced at SEND time (a pending invite reserves a seat),
    // but a cap reduction (billing downgrade) between send and accept can leave
    // the account over its NEW cap as reserved invites accept — the one seat path
    // with neither a pre- nor post-write accept check. Re-count now, AFTER the
    // invite is flipped to 'accepted' (so this invitee's reservation is no longer
    // double-counted alongside their new membership) and abort the whole
    // acceptance tx if over cap. seatCapacityStillWithinCap counts DISTINCT member
    // userIds, so an invitee who already held a seat elsewhere isn't falsely
    // blocked.
    if (!(await seatCapacityStillWithinCap(String(org._id), session))) {
      throw new Error(INV_SEAT_LIMIT);
    }

    // Fire-and-forget acceptance notification to the inviter.
    const inviter = await User.findById(invitation.invitedBy).session(session);
    if (inviter) {
      emailService.sendInvitationAccepted(inviter.email, inviter.username, user.username, org.name)
        .catch(error => logger.error('Failed to send acceptance notification', { error }));
    }
  }

  /**
   * Tombstone an invitation as accepted (status + acceptedAt/By/Via) without
   * creating a membership — used on the already-a-member path so the audit
   * trail still records the click. See the callers for why this write must
   * survive the transaction commit.
   */
  private async tombstoneAccepted(
    invitation: InvitationDocument,
    user: UserDocument,
    via: 'email' | InvitationOAuthProvider,
    session: mongoose.ClientSession,
  ): Promise<void> {
    invitation.status = 'accepted';
    invitation.acceptedAt = new Date();
    invitation.acceptedBy = user._id;
    invitation.acceptedVia = via;
    await invitation.save({ session });
  }

  /**
   * Send a new invitation to an email. Validates ownership/admin-ship,
   * detects existing membership + pending invitations, enforces the
   * per-org pending cap, and triggers the invitation email. Wrapped in a
   * single Mongo transaction so half-completed sends can't leak rows.
   */
  async send(input: SendInvitationInput): Promise<SendInvitationResult> {
    const { invitation, inviterName, organizationName, allowedOAuthProviders } = await withMongoTransaction(async (session) => {
      const org = await Organization.findById(toOrgId(input.orgId)).session(session);
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

      // Expire a stale (expired-but-still-pending) invite for this email up
      // front so it stops counting toward the pending / seat ceilings below
      // (otherwise a re-invite over-counts its own prior invite by one). Any
      // later throw rolls this back with the transaction.
      if (existingInvitation) {
        existingInvitation.status = 'expired';
        await existingInvitation.save({ session });
      }

      // Count only GENUINELY-LIVE pending invites toward the per-org cap.
      // Invitations expire lazily, so a `status:'pending'` row can outlive its
      // `expiresAt`; without the `expiresAt > now` guard an org whose invites
      // are never accepted would sit at its pending ceiling forever and be
      // unable to invite anyone new. (The same-email stale row is already
      // flipped to 'expired' just above; this guard covers OTHER emails' stale
      // rows. The reaper backstops the data self-healing.)
      const pendingCount = await Invitation.countDocuments({
        organizationId: toOrgId(input.orgId), status: 'pending', expiresAt: { $gt: new Date() },
      }).session(session);
      if (pendingCount >= config.invitation.maxPendingPerOrg) {
        throw new Error(INV_MAX_REACHED);
      }

      // Seat-limit enforcement — pooled at the account ROOT (a pending invite
      // reserves a seat). The helper resolves root + subtree and the root's
      // seat limit internally; `-1` (unlimited) short-circuits.
      if (!(await seatCapacityAvailable(input.orgId, 1, session))) {
        throw new Error(INV_SEAT_LIMIT);
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

      // Post-write seat re-check — pairs with the pre-write `seatCapacityAvailable`
      // above. Two concurrent invites can both clear the pre-check, so re-verify
      // against the freshly-written state and roll back the loser. Mirrors every
      // other seat-consuming path (members/user-admin/domain-join).
      if (!(await seatCapacityStillWithinCap(input.orgId, session))) {
        throw new Error(INV_SEAT_LIMIT);
      }

      const inviter = await User.findById(input.inviterId).session(session);
      if (!inviter) throw new Error(INV_INVITER_NOT_FOUND);

      // Return the fields the email needs; SEND it after commit (below). The send is
      // a non-idempotent side effect and must not run inside the retryable
      // transaction body — a commit-retry would otherwise re-send the invitation.
      return { invitation: created, inviterName: inviter.username, organizationName: org.name, allowedOAuthProviders: created.allowedOAuthProviders };
    });

    const emailSent = await emailService.sendInvitation({
      recipientEmail: input.email.toLowerCase(),
      inviterName,
      organizationName,
      invitationToken: invitation.token,
      expiresAt: invitation.expiresAt,
      role: input.role,
      invitationType: input.invitationType,
      allowedOAuthProviders,
    });

    return { invitation, emailSent };
  }

  /**
   * Accept an invitation as the currently-logged-in user. Verifies the
   * caller's email matches the invitee, that the OAuth/email accept method
   * is allowed by the invitation, and that they're not already a member.
   * Throws INV_USER_NOT_FOUND / INV_EMAIL_MISMATCH / INV_ALREADY_MEMBER /
   * etc. on the various failure cases.
   */
  async accept(token: string, userId: string, oauthProvider?: InvitationOAuthProvider): Promise<InvitationAcceptResult> {
    // `alreadyMember` is set inside the tx and acted on AFTER commit. If we
    // threw INV_ALREADY_MEMBER from inside the tx body, withTransaction
    // would roll back the `invitation.status = 'accepted'` write — losing
    // the audit-trail tombstone we explicitly want to keep.
    let result: InvitationAcceptResult | null = null;
    const alreadyMember = await withMongoTransaction(async (session) => {
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
        // Tombstone the invitation as accepted so the audit trail records
        // the click, then signal the caller (outside the tx) to surface
        // INV_ALREADY_MEMBER without rolling back the status update.
        await this.tombstoneAccepted(invitation, user, oauthProvider || 'email', session);
        return true;
      }

      await this.processAcceptance(invitation, user, org, oauthProvider || 'email', session);
      // Facts the controller audits as `invitation.accept` (a privilege grant).
      // No token — email + role + ids only.
      result = {
        invitationId: String(invitation._id),
        organizationId: String(invitation.organizationId),
        email: invitation.email,
        role: invitation.role,
        userId,
      };
      return false;
    });

    if (alreadyMember) throw new Error(INV_ALREADY_MEMBER);
    return result!;
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
  ): Promise<InvitationAcceptResult> {
    // Same already-member-after-commit pattern as `accept` — see comment there.
    let result: InvitationAcceptResult | null = null;
    const alreadyMember = await withMongoTransaction(async (session) => {
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
        await this.tombstoneAccepted(invitation, user, oauthProvider, session);
        return true;
      }

      await this.processAcceptance(invitation, user, org, oauthProvider, session);
      // The accepting user is resolved/created server-side here (no `req.user`),
      // so surface their id for the controller's actor attribution.
      result = {
        invitationId: String(invitation._id),
        organizationId: String(invitation.organizationId),
        email: invitation.email,
        role: invitation.role,
        userId: String(user._id),
      };
      return false;
    });

    if (alreadyMember) throw new Error(INV_ALREADY_MEMBER);
    return result!;
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
   * List invitations for an org with optional status / type / role filters, a
   * case-insensitive email `search`, and pagination. Populates the invitedBy +
   * acceptedBy user references for the dashboard's "who invited whom" UI.
   */
  async listForOrg(orgId: string, opts: {
    status?: string;
    invitationType?: string;
    role?: string;
    search?: string;
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
    if (opts.role && ['admin', 'member'].includes(opts.role)) {
      query.role = opts.role;
    }
    // Email search — a case-insensitive substring match on the invitee address,
    // escaped so metacharacters can't change the query semantics (ReDoS/search
    // correctness), mirroring the member-roster search.
    if (opts.search && opts.search.trim()) {
      query.email = new RegExp(escapeRegex(opts.search.trim()), 'i');
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
  async revoke(invitationId: string, orgId: string, userId: string, isAdmin: boolean): Promise<InvitationAuditInfo> {
    const invitation = await Invitation.findOne({ _id: invitationId, organizationId: toOrgId(orgId) });
    if (!invitation) throw new Error(INV_NOT_FOUND);
    if (invitation.status !== 'pending') throw new Error(INV_NOT_PENDING);

    const org = await Organization.findById(toOrgId(orgId));
    if (!org || (org.owner.toString() !== userId && !isAdmin)) {
      throw new Error(INV_UNAUTHORIZED);
    }

    invitation.status = 'revoked';
    await invitation.save();

    return {
      invitationId: String(invitation._id),
      organizationId: String(invitation.organizationId),
      email: invitation.email,
      role: invitation.role,
    };
  }

  /**
   * Re-send an invitation email and reset its expiry. Verifies caller
   * authz against the org. Returns the new expiry + whether the email
   * actually sent (false → caller can decide to surface a 500 if email
   * is required).
   */
  async resend(invitationId: string, orgId: string, userId: string, isAdmin: boolean): Promise<{ expiresAt: Date; emailSent: boolean; email: string; role: string }> {
    const invitation = await Invitation.findOne({
      _id: invitationId, organizationId: toOrgId(orgId), status: 'pending',
    });
    if (!invitation) throw new Error(INV_NOT_FOUND);

    const org = await Organization.findById(toOrgId(orgId));
    if (!org || (org.owner.toString() !== userId && !isAdmin)) {
      throw new Error(INV_UNAUTHORIZED);
    }

    const inviter = await User.findById(invitation.invitedBy);
    if (!inviter) throw new Error(INV_INVITER_NOT_FOUND);

    // A LAPSED (expired-but-still-pending) invite no longer counts toward seat
    // usage (`seats.ts` guards `expiresAt > now`); re-arming it re-reserves a seat,
    // so re-check capacity against the (possibly billing-reduced) cap first. A
    // still-live invite already holds its seat — no re-check needed.
    if (invitation.expiresAt.getTime() < Date.now() && !(await seatCapacityAvailable(orgId, 1))) {
      throw new Error(INV_SEAT_LIMIT);
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

    return { expiresAt: invitation.expiresAt, emailSent, email: invitation.email, role: invitation.role };
  }
}

export const invitationService = new InvitationService();
