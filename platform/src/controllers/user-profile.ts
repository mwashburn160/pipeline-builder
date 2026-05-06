// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, resolveUserFeatures, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { FeatureFlag, QuotaTier } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { audit } from '../helpers/audit';
import { requireAuthUserId, withController } from '../helpers/controller-helper';
import {
  userProfileService,
  PROFILE_USER_NOT_FOUND,
  PROFILE_EMAIL_TAKEN,
  PROFILE_INVALID_CREDENTIALS,
  PROFILE_OWNER_HAS_ORGS,
} from '../services';
import { issueTokens } from '../utils/token';
import { validateBody, updateProfileSchema, changePasswordSchema } from '../utils/validation';

const logger = createLogger('UserProfileController');

const profileErrorMap = {
  [PROFILE_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [PROFILE_EMAIL_TAKEN]: { status: 409, message: 'Email already in use' },
  [PROFILE_INVALID_CREDENTIALS]: { status: 401, message: 'Current password incorrect' },
  [PROFILE_OWNER_HAS_ORGS]: { status: 400, message: 'Cannot delete account while you own an organization. Transfer ownership first.' },
};

/** Compact organization summary included in user responses. */
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

/** Membership info returned alongside user responses. */
export interface OrgMembership {
  id: string;
  name: string;
  role: string;
}

/** Fields required to build a user API response. */
export interface UserResponseInput {
  _id: Types.ObjectId;
  username: string;
  email: string;
  isEmailVerified: boolean;
  lastActiveOrgId?: Types.ObjectId | string;
  featureOverrides?: Map<string, boolean> | Record<string, boolean>;
  createdAt?: Date;
  updatedAt?: Date;
  tokenVersion?: number;
}

/** Convert Mongoose Map or plain object to Record<string, boolean>. */
export function toOverridesRecord(overrides?: Map<string, boolean> | Record<string, boolean>): Record<string, boolean> | undefined {
  if (!overrides) return undefined;
  if (overrides instanceof Map) return Object.fromEntries(overrides);
  return overrides;
}

/** Build a standardized user response object for API output. */
export function formatUserResponse(
  user: UserResponseInput,
  opts?: {
    activeOrgRole?: string;
    activeOrgName?: string | null;
    organization?: OrgSummary;
    organizations?: OrgMembership[];
    tier?: QuotaTier;
    features?: FeatureFlag[];
  },
) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: opts?.activeOrgRole || null,
    isEmailVerified: user.isEmailVerified,
    organizationId: user.lastActiveOrgId?.toString() || null,
    organizationName: opts?.activeOrgName || null,
    ...(opts?.organization && { organization: opts.organization }),
    ...(opts?.organizations && { organizations: opts.organizations }),
    ...(opts?.tier && { tier: opts.tier }),
    ...(opts?.features && { features: opts.features }),
    ...(user.featureOverrides && { featureOverrides: toOverridesRecord(user.featureOverrides) }),
    ...(user.createdAt && { createdAt: user.createdAt }),
    ...(user.updatedAt && { updatedAt: user.updatedAt }),
    ...(user.tokenVersion !== undefined && { tokenVersion: user.tokenVersion }),
  };
}

/** GET /user/profile — current user with active-org context. */
export const getUser = withController('Get user profile', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const { user, memberships, orgMap } = await userProfileService.getProfileWithOrgs(userId);

  const organizations: OrgMembership[] = memberships.map(m => {
    const org = orgMap.get(m.organizationId.toString());
    return { id: m.organizationId.toString(), name: org?.name || 'Unknown', role: m.role };
  });

  // Resolve active org tier and features for the JWT-active org.
  const activeOrgId = req.user!.organizationId || (user as { lastActiveOrgId?: { toString(): string } }).lastActiveOrgId?.toString();
  let activeOrgName: string | null = null;
  let activeOrgRole: string | null = null;
  let tier: QuotaTier = 'developer';
  let isSystem = false;

  if (activeOrgId) {
    const activeOrg = orgMap.get(activeOrgId.toString());
    if (activeOrg) {
      activeOrgName = activeOrg.name;
      tier = (activeOrg.tier as QuotaTier) || 'developer';
      isSystem = activeOrgId.toString() === SYSTEM_ORG_ID;
    }
    const activeMembership = memberships.find(m => m.organizationId.toString() === activeOrgId.toString());
    activeOrgRole = activeMembership?.role || null;
  }

  const overrides = toOverridesRecord((user as { featureOverrides?: Map<string, boolean> }).featureOverrides);
  const features = resolveUserFeatures(tier, overrides, isSystem);

  sendSuccess(res, 200, {
    user: formatUserResponse(user as UserResponseInput, {
      activeOrgRole: activeOrgRole || undefined,
      activeOrgName,
      organizations,
      tier,
      features,
    }),
  });
}, profileErrorMap);

/** GET /user/organizations — all org memberships for the current user. */
export const listUserOrganizations = withController('List user organizations', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const organizations = await userProfileService.listOrganizations(userId);
  sendSuccess(res, 200, { organizations });
});

/** PATCH /user/profile — update username and/or email. */
export const updateUser = withController('Update user profile', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const body = validateBody(updateProfileSchema, req.body, res);
  if (!body) return;

  const { user, organizationName, activeOrgRole } = await userProfileService.updateProfile(userId, body);
  logger.info('Update user success', { userId });
  sendSuccess(res, 200, { user: formatUserResponse(user as UserResponseInput, { activeOrgRole, activeOrgName: organizationName }) });
}, profileErrorMap);

/** DELETE /user/account — refuses if user owns any orgs. */
export const deleteUser = withController('Delete user account', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  await userProfileService.deleteAccount(userId);
  logger.info('Account deleted', { userId });
  audit(req, 'user.delete', { targetType: 'user', targetId: userId });
  sendSuccess(res, 200, undefined, 'Account successfully deleted');
}, profileErrorMap);

/** POST /user/change-password — verify current pw + bump tokenVersion. */
export const changePassword = withController('Change password', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const body = validateBody(changePasswordSchema, req.body, res);
  if (!body) return;

  await userProfileService.changePassword(userId, body.currentPassword, body.newPassword);
  logger.info('Password change success', { userId });
  sendSuccess(res, 200, undefined, 'Password changed successfully');
}, profileErrorMap);

/**
 * POST /user/generate-token
 * Body: { expiresIn?: number } — token lifetime in seconds (max 365 days).
 */
export const generateToken = withController('Generate token', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  // Custom expiry cap matches pipeline-manager CLI's --days 365 ceiling.
  const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;
  let expiresIn: number | undefined;
  if (req.body?.expiresIn !== undefined) {
    expiresIn = parseInt(req.body.expiresIn, 10);
    if (isNaN(expiresIn) || expiresIn < 1) {
      return sendError(res, 400, 'expiresIn must be a positive integer (seconds)', 'INVALID_EXPIRES_IN');
    }
    if (expiresIn > MAX_EXPIRES_IN) {
      return sendError(res, 400, `expiresIn must not exceed ${MAX_EXPIRES_IN} seconds (365 days)`, 'EXPIRES_IN_TOO_LARGE');
    }
  }

  const user = await userProfileService.findForTokenIssue(userId);
  const { accessToken, refreshToken, expiresIn: actual } = await issueTokens(
    user, user.lastActiveOrgId?.toString(), expiresIn,
  );
  sendSuccess(res, 200, { accessToken, refreshToken, expiresIn: actual });
}, profileErrorMap);

/** GET /user/tokens — recent access-token history with computed status. */
export const listTokenHistory = withController('List token history', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const tokens = await userProfileService.listTokenHistory(userId);
  sendSuccess(res, 200, { tokens });
}, profileErrorMap);

/** POST /user/tokens/revoke-all — sign out everywhere + issue a fresh token. */
export const revokeAllTokens = withController('Revoke all tokens', async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  const user = await userProfileService.revokeAllSessions(userId);
  audit(req, 'user.tokens.revoke-all', { targetType: 'user', targetId: userId });

  // Issue a fresh token at the new tokenVersion so the active session survives.
  const { accessToken, refreshToken, expiresIn } = await issueTokens(user, user.lastActiveOrgId?.toString());
  sendSuccess(res, 200, { revoked: true, accessToken, refreshToken, expiresIn });
}, profileErrorMap);
