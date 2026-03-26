import crypto from 'crypto';
import { createLogger } from '@mwashburn160/api-core';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User, Organization } from '../models';
import { UserDocument } from '../models/user';
import { AccessTokenPayload, RefreshTokenPayload } from '../types';

const logger = createLogger('Token');

/** Build an access token JWT payload from a user document. */
export function createAccessTokenPayload(user: UserDocument, organizationName?: string): AccessTokenPayload {
  return {
    type: 'access',
    sub: user._id.toString(),
    organizationId: user.organizationId?.toString(),
    ...(organizationName && { organizationName }),
    username: user.username,
    email: user.email,
    role: user.role,
    isAdmin: user.role === 'admin',
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
export function generateAccessToken(user: UserDocument): string {
  return jwt.sign(createAccessTokenPayload(user), config.auth.jwt.secret, {
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
export function generateTokenPair(user: UserDocument): { accessToken: string; refreshToken: string } {
  return {
    accessToken: generateAccessToken(user),
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
 * Generate a new token pair and persist the hashed refresh token in the database.
 * Resolves the organization name for inclusion in the access token payload.
 *
 * @param user - User document to generate tokens for
 * @param expiresIn - Optional access token lifetime in seconds (default: config.auth.jwt.expiresIn)
 */
export async function issueTokens(user: UserDocument, expiresIn?: number): Promise<IssuedTokens> {
  const tokenExpiresIn = expiresIn ?? config.auth.jwt.expiresIn;

  let organizationName: string | undefined;
  if (user.organizationId) {
    try {
      const org = await Organization.findById(user.organizationId).select('name').lean();
      organizationName = org?.name;
    } catch (error) {
      logger.warn('Failed to fetch organization name for token', { error });
    }
  }

  const accessToken = jwt.sign(
    createAccessTokenPayload(user, organizationName),
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
