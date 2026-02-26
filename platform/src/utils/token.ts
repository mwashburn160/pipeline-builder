/**
 * @module utils/token
 * @description JWT token generation and verification utilities.
 * Provides functions for creating, signing, verifying, and persisting
 * access and refresh token pairs.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models';
import { UserDocument } from '../models/user';
import { AccessTokenPayload, RefreshTokenPayload } from '../types';

/**
 * Build an access token JWT payload from a user document.
 * @param user - Mongoose user document
 * @returns Payload object ready for signing
 */
export function createAccessTokenPayload(user: UserDocument): AccessTokenPayload {
  return {
    type: 'access',
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

/**
 * Generate a new token pair and persist the hashed refresh token in the database.
 * @param user - Mongoose user document
 * @returns Access and refresh token strings
 */
export async function issueTokens(user: UserDocument): Promise<{ accessToken: string; refreshToken: string }> {
  const { accessToken, refreshToken } = generateTokenPair(user);
  const hashedRefresh = hashRefreshToken(refreshToken);
  await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashedRefresh } });
  return { accessToken, refreshToken };
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
