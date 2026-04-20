// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError } from '@pipeline-builder/api-core';
import { Response } from 'express';
import { z } from 'zod';
import { config } from '../config';

/**
 * Validate data against a Zod schema.
 * Returns parsed value or null (sends 400 response on failure).
 */
export function validateBody<T>(
  schema: z.ZodType<T>,
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

/**
 * Relaxed email regex: requires local@domain but does NOT require a TLD.
 * Accepts both "user@internal" and "user@internal.com".
 */
export const emailSchema = z.string().regex(/^[^\s@]+@[^\s@]+$/, 'Invalid email address');

/** Password schema: enforces minimum length, uppercase, lowercase, and digit requirements. */
const passwordSchema = z.string().min(config.auth.passwordMinLength).max(128)
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one digit');

// Auth Schemas

/** Registration request body schema. */
export const registerSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i, 'Username must contain only letters, numbers, hyphens, and underscores'),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().min(2).max(100).optional(),
  planId: z.string().optional(),
});

/** Login request body schema (identifier can be username or email). */
export const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

/** Token refresh request body schema. */
export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// OAuth Schemas

/** OAuth callback request body schema (authorization code + CSRF state). */
export const oauthCallbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
});

// User Schemas

/** User profile update schema (at least one field required). */
export const updateProfileSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i).optional(),
  email: emailSchema.optional(),
}).refine(data => data.username || data.email, {
  message: 'At least one field (username or email) is required',
});

/** Password change request schema. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

// Invitation Schemas

/** Invitation send request schema. */
export const sendInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(['admin', 'member']).optional().default('member'),
  invitationType: z.enum(['email', 'oauth', 'any']).optional().default('any'),
  allowedOAuthProviders: z.array(z.enum(['google', 'github'])).optional(),
});

// Organization Schemas

/** Create organization schema (name required, tier defaults to developer). */
export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  tier: z.enum(['developer', 'pro', 'unlimited']).optional().default('developer'),
});

/** Organization update schema (name and/or description). */
export const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
});

/** Add member schema (either userId or email required, with optional role). */
export const addMemberSchema = z.object({
  userId: z.string().optional(),
  email: emailSchema.optional(),
  role: z.enum(['owner', 'admin', 'member']).optional().default('member'),
}).refine(data => data.userId || data.email, {
  message: 'Either userId or email is required',
});

/** Member role update schema. */
export const updateMemberRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
});

/** Organization ownership transfer schema. */
export const transferOwnershipSchema = z.object({
  newOwnerId: z.string().min(1, 'New owner ID is required'),
});

/** Switch active organization schema. */
export const switchOrgSchema = z.object({
  organizationId: z.string().min(1, 'Organization ID is required'),
});

/** Quota limits update schema (values can be numbers or 'unlimited'). */
export const updateQuotasSchema = z.object({
  plugins: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  pipelines: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  apiCalls: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
});

