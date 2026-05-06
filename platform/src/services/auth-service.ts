// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { User, Organization, UserOrganization } from '../models';
import { hashRefreshToken } from '../utils/token';

const logger = createLogger('AuthService');

/** Token validity period for email verification (24 hours). */
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Domain error codes thrown by service methods (mapped to HTTP status by the controller). */
export const DUPLICATE_CREDENTIALS = 'DUPLICATE_CREDENTIALS';

interface RegisterInput {
  username: string;
  email: string;
  password: string;
  organizationName?: string;
  planId?: string;
}

interface RegisterResult {
  sub: string;
  email: string;
  role: 'owner';
  organizationId: string;
  organizationName: string;
  planId: string;
}

interface VerificationDispatch {
  /** Pre-hashed token to send via email link. The hash is what gets persisted; the raw token is what the user clicks. */
  rawToken: string;
  email: string;
  /** Pre-existing verified state — caller skips sending the email entirely if true. */
  alreadyVerified: boolean;
}

class AuthService {
  /**
   * Register a new user + organization + membership in a single Mongo transaction.
   * The org name normalizes (trims, falls back to username); when it equals
   * 'system' (case-insensitive), the org is created with the system tier
   * + unlimited quotas + the literal `system` _id.
   *
   * Throws `DUPLICATE_CREDENTIALS` if email or username is already taken.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    const session = await mongoose.startSession();

    try {
      let result!: RegisterResult;

      await session.withTransaction(async () => {
        const { username, email, password, organizationName, planId } = input;

        const existing = await User.exists({
          $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
        }).session(session);

        if (existing) {
          throw new Error(DUPLICATE_CREDENTIALS);
        }

        const trimmedOrgName = organizationName?.trim();
        const effectiveOrgName = trimmedOrgName && trimmedOrgName.length >= 2
          ? trimmedOrgName
          : username;

        const user = new User({ username, email, password });

        const isSystemOrg = effectiveOrgName.toLowerCase() === SYSTEM_ORG_ID;

        const orgData: Record<string, unknown> = {
          name: isSystemOrg ? SYSTEM_ORG_ID : effectiveOrgName,
          owner: user._id,
        };

        if (isSystemOrg) {
          orgData._id = SYSTEM_ORG_ID;
          orgData.tier = 'unlimited';
          orgData.quotas = { plugins: -1, pipelines: -1, apiCalls: -1 };
        }

        const [org] = await Organization.create([orgData], { session });
        const orgId = String(org._id);

        await UserOrganization.create([{
          userId: user._id,
          organizationId: org._id,
          role: 'owner',
        }], { session });

        user.lastActiveOrgId = org._id as mongoose.Types.ObjectId;
        await user.save({ session });

        result = {
          sub: user._id.toString(),
          email: user.email,
          role: 'owner',
          organizationId: orgId,
          organizationName: org.name,
          planId: isSystemOrg ? 'unlimited' : (planId || 'developer'),
        };
      });

      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Resolve a User by email-or-username + verify the password.
   * Returns null on no-match or wrong password (controller responds 401).
   */
  async findByCredentials(identifier: string, password: string) {
    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
    }).select('+password +tokenVersion');

    if (!user || !(await user.comparePassword(password))) return null;
    return user;
  }

  /**
   * Atomically swap the user's refresh-token hash. Returns the user if the
   * old hash matched (rotation succeeded), null otherwise (token was reused
   * or stolen — caller should invalidate all sessions).
   */
  async rotateRefreshToken(userId: string, oldRefreshToken: string) {
    const oldHash = hashRefreshToken(oldRefreshToken);
    return User.findOne({ _id: userId, refreshToken: oldHash }).select('+refreshToken +tokenVersion');
  }

  /**
   * Bump tokenVersion + clear refresh token to invalidate every active
   * session. Used on logout AND defensively on suspected refresh-token reuse.
   */
  async invalidateAllSessions(userId: string): Promise<void> {
    await User.updateOne(
      { _id: userId },
      { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
    );
  }

  /**
   * Verify the user has an active membership in the target org and update
   * their `lastActiveOrgId`. Returns the user (with tokenVersion selected
   * for re-issuing tokens) on success, or null when membership doesn't
   * exist / is inactive.
   */
  async switchActiveOrg(userId: string, organizationId: string) {
    const membership = await UserOrganization.findOne({
      userId,
      organizationId,
      isActive: true,
    }).lean();
    if (!membership) return null;

    await User.updateOne({ _id: userId }, { $set: { lastActiveOrgId: organizationId } });
    return User.findById(userId).select('+tokenVersion');
  }

  /**
   * Generate + persist an email-verification token for the user. Returns
   * the raw token (caller emails it to the user) or marks already-verified.
   */
  async createVerificationToken(userId: string): Promise<VerificationDispatch | null> {
    const user = await User.findById(userId).select('+emailVerificationToken +emailVerificationExpires');
    if (!user) return null;

    if (user.isEmailVerified) {
      return { rawToken: '', email: user.email, alreadyVerified: true };
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    user.emailVerificationToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.emailVerificationExpires = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
    await user.save();

    return { rawToken, email: user.email, alreadyVerified: false };
  }

  /**
   * OAuth login flow: find a user by their provider ID, fall back to
   * email-match (linking the OAuth account in that case), or auto-create
   * a fresh user with a personal org. Username generation strips
   * non-`[a-z0-9_-]` from the OAuth-supplied name/email and probes for
   * the first un-taken `<base><n>` form so concurrent OAuth registrations
   * don't collide.
   */
  async findOrCreateOAuthUser(providerName: string, userInfo: { id: string; email: string; name?: string; picture?: string }) {
    const byOAuth = await User.findOne({ [`oauth.${providerName}.id`]: userInfo.id }).select('+tokenVersion');
    if (byOAuth) return byOAuth;

    const byEmail = await User.findOne({ email: userInfo.email.toLowerCase() }).select('+tokenVersion');
    if (byEmail) {
      await User.updateOne({ _id: byEmail._id }, {
        $set: { [`oauth.${providerName}`]: { id: userInfo.id, email: userInfo.email, name: userInfo.name, picture: userInfo.picture, linkedAt: new Date() } },
      });
      return byEmail;
    }

    const baseUsername = (userInfo.name || userInfo.email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    let username = baseUsername;
    let suffix = 1;
    while (await User.exists({ username })) { username = `${baseUsername}${suffix++}`; }

    const newUser = new User({
      username,
      email: userInfo.email.toLowerCase(),
      isEmailVerified: true,
      tokenVersion: 0,
      oauth: { [providerName]: { id: userInfo.id, email: userInfo.email, name: userInfo.name, picture: userInfo.picture, linkedAt: new Date() } },
    });

    // Auto-create personal org + owner membership (mirrors the email-registration flow).
    const org = await Organization.create({ name: username, owner: newUser._id });
    await UserOrganization.create({ userId: newUser._id, organizationId: org._id, role: 'owner' });
    newUser.lastActiveOrgId = org._id as mongoose.Types.ObjectId;

    await newUser.save();
    return newUser;
  }

  /**
   * Look up a user by the hash of the supplied verification token, mark
   * them verified, and clear the token fields. Returns the user on
   * success, null when the token is invalid or expired.
   */
  async verifyEmailWithToken(rawToken: string) {
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: new Date() },
    }).select('+emailVerificationToken +emailVerificationExpires');

    if (!user) return null;

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();
    logger.info('Email verified', { userId: user._id.toString(), email: user.email });
    return user;
  }
}

export const authService = new AuthService();
