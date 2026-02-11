/**
 * @module controllers/auth-utils
 * @description Authentication utilities for token generation, validation, and password hashing
 */

import crypto from 'crypto';
import { createLogger, sendError } from '@mwashburn160/api-core';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { z, ZodSchema } from 'zod';
import { config } from '../config';
import { emailSchema } from './validation';
import type { IUser } from '../models/user.model';

const logger = createLogger('AuthUtils');

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Registration schema
 */
export const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  email: emailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters'),
  organizationName: z.string().optional(),
});

/**
 * Login schema
 */
export const loginSchema = z.object({
  identifier: z.string().min(1, 'Username or email is required'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Refresh token schema
 */
export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ============================================================================
// Validation Helper
// ============================================================================

/**
 * Validate request body with Zod schema
 * Returns parsed body or null (and sends error response)
 *
 * @param schema - Zod schema to validate against
 * @param body - Request body to validate
 * @param res - Express response (for sending error)
 * @returns Parsed body or null if validation fails
 */
export function validateBody<T>(
  schema: ZodSchema<T>,
  body: unknown,
  res: Response,
): T | null {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Validation failed';
      sendError(res, 400, message, 'VALIDATION_ERROR');
      return null;
    }
    sendError(res, 400, 'Validation failed', 'VALIDATION_ERROR');
    return null;
  }
}

// ============================================================================
// Token Generation
// ============================================================================

export interface TokenPayload {
  type: 'access';
  sub: string;
  email: string;
  role: string;
  organizationId: string;
  organizationName?: string;
  tokenVersion?: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Generate and store JWT access/refresh tokens for a user
 *
 * @param user - User document
 * @returns Token pair with expiry
 */
export async function issueTokens(user: IUser): Promise<IssuedTokens> {
  const payload: TokenPayload = {
    type: 'access',
    sub: user._id.toString(),
    email: user.email,
    role: user.role,
    organizationId: user.organizationId?.toString() || '',
    tokenVersion: user.tokenVersion || 0,
  };

  // Get organization name if needed
  if (user.organizationId) {
    try {
      const { Organization } = await import('../models/index.js');
      const org = await Organization.findById(user.organizationId).select('name');
      if (org) {
        payload.organizationName = org.name;
      }
    } catch (error) {
      logger.warn('Failed to fetch organization name for token', { error });
    }
  }

  const accessToken = jwt.sign(payload, config.auth.jwt.secret, {
    expiresIn: `${config.auth.jwt.expiresIn}s`,
  });

  // Generate refresh token (random, long-lived)
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenHash = hashRefreshToken(refreshToken);

  // Store hashed refresh token in database
  user.refreshToken = refreshTokenHash;
  await user.save();

  return {
    accessToken,
    refreshToken,
    expiresIn: config.auth.jwt.expiresIn,
  };
}

/**
 * Hash a refresh token for storage
 *
 * @param token - Plain refresh token
 * @returns SHA-256 hash
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
