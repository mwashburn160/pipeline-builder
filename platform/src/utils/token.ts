import crypto from 'crypto';
import { createLogger, resolveUserFeatures, isSystemOrgId } from '@mwashburn160/api-core';
import type { QuotaTier } from '@mwashburn160/api-core';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User, Organization, UserOrganization } from '../models';
import { UserDocument } from '../models/user';
import type { OrgMemberRole } from '../models/user-organization';
import { AccessTokenPayload, RefreshTokenPayload } from '../types';

const logger = createLogger('Token');

/** Membership context for token payload. */
export interface MembershipContext {
  organizationId: string;
  organizationName?: string;
  role: OrgMemberRole;
  tier?: string;
}

/** Build an access token JWT payload from a user document and optional membership. */
export function createAccessTokenPayload(user: UserDocument, membership?: MembershipContext): AccessTokenPayload {
  const role = membership?.role ?? 'member';
  const tier = (membership?.tier as QuotaTier) || 'developer';
  const isSystem = isSystemOrgId(membership?.organizationId, membership?.organizationName);
  const overrides = user.featureOverrides
    ? Object.fromEntries(user.featureOverrides as Map<string, boolean>)
    : undefined;
  return {
    type: 'access',
    sub: user._id.toString(),
    organizationId: membership?.organizationId,
    ...(membership?.organizationName && { organizationName: membership.organizationName }),
    username: user.username,
    email: user.email,
    role,
    isAdmin: role === 'admin' || role === 'owner',
    tier,
    features: resolveUserFeatures(tier, overrides, isSystem),
    tokenVersion: user.tokenVersion,
    isEmailVerified: user.isEmailVerified,
  };
}

/** Build a refresh token JWT payload from a user document. */
export function createRefreshTokenPayload(user: UserDocument): RefreshTokenPayload {
  return {
    type: 'refresh',
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
  };
}

/** Sign and return a JWT access token for the given user. */
export function generateAccessToken(user: UserDocument, membership?: MembershipContext): string {
  return jwt.sign(createAccessTokenPayload(user, membership), config.auth.jwt.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: config.auth.jwt.expiresIn,
  });
}

/** Sign and return a JWT refresh token for the given user. */
export function generateRefreshToken(user: UserDocument): string {
  return jwt.sign(createRefreshTokenPayload(user), config.auth.refreshToken.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: config.auth.refreshToken.expiresIn,
  });
}

/** Generate both access and refresh tokens for a user. */
export function generateTokenPair(user: UserDocument, membership?: MembershipContext): { accessToken: string; refreshToken: string } {
  return {
    accessToken: generateAccessToken(user, membership),
    refreshToken: generateRefreshToken(user),
  };
}

/**
 * Hash a refresh token using SHA-256 for secure storage.
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Shape returned by {@link issueTokens}. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Resolve the membership context for a user's active organization.
 * Looks up UserOrganization + Organization name for the given orgId.
 * Falls back to user.lastActiveOrgId, then first membership.
 */
async function resolveMembership(userId: string, activeOrgId?: string): Promise<MembershipContext | undefined> {
  // Try explicit activeOrgId first
  if (activeOrgId) {
    const membership = await UserOrganization.findOne({ userId, organizationId: activeOrgId, isActive: true }).lean();
    if (membership) {
      const org = await Organization.findById(activeOrgId).select('name tier').lean();
      return {
        organizationId: activeOrgId,
        organizationName: org?.name,
        role: membership.role as OrgMemberRole,
        tier: (org as unknown as Record<string, unknown>)?.tier as string | undefined,
      };
    }
  }

  // Fall back to first membership
  const first = await UserOrganization.findOne({ userId, isActive: true }).sort({ joinedAt: 1 }).lean();
  if (!first) return undefined;

  const orgId = first.organizationId.toString();
  const org = await Organization.findById(orgId).select('name tier').lean();
  return {
    organizationId: orgId,
    organizationName: org?.name,
    role: first.role as OrgMemberRole,
    tier: (org as unknown as Record<string, unknown>)?.tier as string | undefined,
  };
}

/**
 * Generate a new token pair and persist the hashed refresh token in the database.
 *
 * Resolves the user's membership context by looking up {@link UserOrganization}
 * for the active org. The resulting access token JWT contains:
 * - `role`: the user's per-org role ('owner' | 'admin' | 'member')
 * - `isAdmin`: derived as `role === 'admin' || role === 'owner'`
 * - `organizationId` / `organizationName`: the active org context
 *
 * Falls back to `user.lastActiveOrgId`, then the user's earliest active membership.
 *
 * @param user - User document to generate tokens for
 * @param activeOrgId - Optional org ID to use as active (falls back to lastActiveOrgId, then first membership)
 * @param expiresIn - Optional access token lifetime in seconds (default: config.auth.jwt.expiresIn)
 */
export async function issueTokens(user: UserDocument, activeOrgId?: string, expiresIn?: number): Promise<IssuedTokens> {
  const tokenExpiresIn = expiresIn ?? config.auth.jwt.expiresIn;

  let membership: MembershipContext | undefined;
  try {
    membership = await resolveMembership(
      user._id.toString(),
      activeOrgId || user.lastActiveOrgId?.toString(),
    );
  } catch (error) {
    logger.warn('Failed to resolve membership for token', { error });
  }

  const accessToken = jwt.sign(
    createAccessTokenPayload(user, membership),
    config.auth.jwt.secret,
    { algorithm: config.auth.jwt.algorithm, expiresIn: tokenExpiresIn },
  );

  const refreshToken = generateRefreshToken(user);
  const hashedRefresh = hashRefreshToken(refreshToken);

  await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashedRefresh } });

  return { accessToken, refreshToken, expiresIn: tokenExpiresIn };
}

/** Verify and decode a JWT access token. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.auth.jwt.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as AccessTokenPayload;
}

/** Verify and decode a JWT refresh token. */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.auth.refreshToken.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as RefreshTokenPayload;
}
