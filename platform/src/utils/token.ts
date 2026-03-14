import crypto from 'crypto';
import { createLogger } from '@mwashburn160/api-core';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User, Organization } from '../models';
import { UserDocument } from '../models/user';
import { AccessTokenPayload, RefreshTokenPayload } from '../types';

const logger = createLogger('Token');

/**
 * Build an access token JWT payload from a user document.
 * @param user - Mongoose user document
 * @param organizationName - Resolved org name (optional)
 * @returns Payload object ready for signing
 */
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

/**
 * Build a refresh token JWT payload from a user document.
 * @param user - Mongoose user document
 * @returns Payload object ready for signing
 */
export function createRefreshTokenPayload(user: UserDocument): RefreshTokenPayload {
  return {
    type: 'refresh',
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
  };
}

/**
 * Sign and return a JWT access token for the given user.
 * @param user - Mongoose user document
 * @returns Signed JWT string
 */
export function generateAccessToken(user: UserDocument): string {
  return jwt.sign(createAccessTokenPayload(user), config.auth.jwt.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: config.auth.jwt.expiresIn,
  });
}

/**
 * Sign and return a JWT refresh token for the given user.
 * @param user - Mongoose user document
 * @returns Signed JWT string
 */
export function generateRefreshToken(user: UserDocument): string {
  return jwt.sign(createRefreshTokenPayload(user), config.auth.refreshToken.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: config.auth.refreshToken.expiresIn,
  });
}

/**
 * Generate both access and refresh tokens for a user.
 * @param user - Mongoose user document
 * @returns Object containing accessToken and refreshToken strings
 */
export function generateTokenPair(user: UserDocument): { accessToken: string; refreshToken: string } {
  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user),
  };
}

/**
 * Hash a refresh token using SHA-256 for secure storage.
 * @param token - Plain-text refresh token
 * @returns Hex-encoded SHA-256 hash
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
 * @param user - Mongoose user document
 * @returns Access token, refresh token, and expiry (seconds)
 */
export async function issueTokens(user: UserDocument): Promise<IssuedTokens> {
  // Resolve organization name for the access token
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
    { algorithm: config.auth.jwt.algorithm, expiresIn: config.auth.jwt.expiresIn },
  );

  const refreshToken = generateRefreshToken(user);
  const hashedRefresh = hashRefreshToken(refreshToken);

  await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashedRefresh } });

  return { accessToken, refreshToken, expiresIn: config.auth.jwt.expiresIn };
}

/**
 * Verify and decode a JWT access token.
 * @param token - JWT string to verify
 * @returns Decoded access token payload
 * @throws If the token is invalid or expired
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.auth.jwt.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as AccessTokenPayload;
}

/**
 * Verify and decode a JWT refresh token.
 * @param token - JWT string to verify
 * @returns Decoded refresh token payload
 * @throws If the token is invalid or expired
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.auth.refreshToken.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as RefreshTokenPayload;
}
