import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models';
import { IUser } from '../models/user.model';
import { AccessTokenPayload, RefreshTokenPayload } from '../types';

/**
 * Create access token payload from user
 */
export function createAccessTokenPayload(user: IUser): AccessTokenPayload {
  return {
    sub: user._id.toString(),
    organizationId: user.organizationId?.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isAdmin: user.role === 'admin',
    tokenVersion: user.tokenVersion,
    isEmailVerified: user.isEmailVerified,
  };
}

/**
 * Create refresh token payload from user
 */
export function createRefreshTokenPayload(user: IUser): RefreshTokenPayload {
  return {
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
  };
}

/**
 * Generate access token
 */
export function generateAccessToken(user: IUser): string {
  return jwt.sign(createAccessTokenPayload(user), config.auth.jwt.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: config.auth.jwt.expiresIn,
  });
}

/**
 * Generate refresh token
 */
export function generateRefreshToken(user: IUser): string {
  return jwt.sign(createRefreshTokenPayload(user), config.auth.refreshToken.secret, {
    algorithm: config.auth.jwt.algorithm,
    expiresIn: config.auth.refreshToken.expiresIn,
  });
}

/**
 * Generate both tokens
 */
export function generateTokenPair(user: IUser): { accessToken: string; refreshToken: string } {
  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user),
  };
}

/**
 * Hash refresh token for storage
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate and persist new token pair for user.
 */
export async function issueTokens(user: IUser): Promise<{ accessToken: string; refreshToken: string }> {
  const { accessToken, refreshToken } = generateTokenPair(user);
  const hashedRefresh = hashRefreshToken(refreshToken);
  await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashedRefresh } });
  return { accessToken, refreshToken };
}

/**
 * Verify access token
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.auth.jwt.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as AccessTokenPayload;
}

/**
 * Verify refresh token
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.auth.refreshToken.secret, {
    algorithms: [config.auth.jwt.algorithm],
  }) as RefreshTokenPayload;
}
