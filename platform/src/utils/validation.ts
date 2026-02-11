/**
 * @module utils/validation
 * @description Zod schemas for input validation on key API endpoints.
 */

import { z } from 'zod';
import { config } from '../config';

/**
 * Relaxed email regex: requires local@domain but does NOT require a TLD.
 * Accepts both "user@internal" and "user@internal.com".
 */
export const emailSchema = z.string().regex(/^[^\s@]+@[^\s@]+$/, 'Invalid email address');

const passwordSchema = z.string().min(config.auth.passwordMinLength).max(128)
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one digit');

// ============================================================================
// Auth Schemas
// ============================================================================

export const registerSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i, 'Username must contain only letters, numbers, hyphens, and underscores'),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().min(2).max(100).optional(),
});

export const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// ============================================================================
// OAuth Schemas
// ============================================================================

export const oauthCallbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
});

// ============================================================================
// User Schemas
// ============================================================================

export const updateProfileSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i).optional(),
  email: emailSchema.optional(),
}).refine(data => data.username || data.email, {
  message: 'At least one field (username or email) is required',
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

// ============================================================================
// Invitation Schemas
// ============================================================================

export const sendInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(['user', 'admin']).optional().default('user'),
  invitationType: z.enum(['email', 'oauth', 'any']).optional().default('any'),
  allowedOAuthProviders: z.array(z.enum(['google'])).optional(),
});

// ============================================================================
// Organization Schemas
// ============================================================================

export const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
});

export const addMemberSchema = z.object({
  userId: z.string().optional(),
  email: emailSchema.optional(),
}).refine(data => data.userId || data.email, {
  message: 'Either userId or email is required',
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(['user', 'admin']),
});

export const transferOwnershipSchema = z.object({
  newOwnerId: z.string().min(1, 'New owner ID is required'),
});

export const updateQuotasSchema = z.object({
  plugins: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  pipelines: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  apiCalls: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
});

// ============================================================================
// Validation Helper
// ============================================================================

import { Response } from 'express';
import { sendError } from './response';

/**
 * Validate request body against a Zod schema.
 * Sends 400 error with validation details if invalid.
 * Returns parsed data on success, null on failure.
 */
export function validateBody<T>(schema: z.ZodSchema<T>, body: unknown, res: Response): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = result.error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ');
    sendError(res, 400, `Validation failed: ${errors}`, 'VALIDATION_ERROR');
    return null;
  }
  return result.data;
}
