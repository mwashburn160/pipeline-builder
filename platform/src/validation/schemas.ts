/**
 * @module controllers/validation-schemas
 * @description Zod validation schemas for platform API controllers
 */

import { z } from 'zod';
import { emailSchema } from '../utils/validation';

// ============================================================================
// Invitation Schemas
// ============================================================================

export const sendInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(['member', 'admin']).default('member'),
  invitationType: z.enum(['email', 'oauth', 'any']).default('any'),
  allowedOAuthProviders: z.array(z.enum(['google'])).optional(),
});

// ============================================================================
// OAuth Schemas
// ============================================================================

export const oauthCallbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
});

// ============================================================================
// Organization Member Schemas
// ============================================================================

export const addMemberSchema = z.object({
  userId: z.string().min(1).optional(),
  email: emailSchema.optional(),
  role: z.enum(['member', 'admin']).default('member'),
}).refine(data => data.userId || data.email, {
  message: 'Either userId or email must be provided',
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(['member', 'admin']),
});

export const transferOwnershipSchema = z.object({
  newOwnerId: z.string().min(1, 'New owner ID is required'),
});

// ============================================================================
// Organization Schemas
// ============================================================================

export const updateOrganizationSchema = z.object({
  name: z.string().min(2, 'Organization name must be at least 2 characters').optional(),
  description: z.string().optional(),
  quotas: z.object({
    plugins: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
    pipelines: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
    apiCalls: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  }).optional(),
});

export const updateQuotasSchema = z.object({
  plugins: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  pipelines: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  apiCalls: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
});

// ============================================================================
// User Schemas
// ============================================================================

export const updateProfileSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').optional(),
  email: emailSchema.optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});
