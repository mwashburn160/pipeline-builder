// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The user object the profile and admin user APIs return. */

import type { FeatureFlag, QuotaTier } from '@pipeline-builder/api-core';
import type { Types } from 'mongoose';

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
  needsOnboarding?: boolean;
  isSuperAdmin?: boolean;
  lastActiveOrgId?: string;
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
    /** Effective fine-grained permissions for the active org (RBAC UI gating). */
    permissions?: string[];
  },
) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: opts?.activeOrgRole || null,
    // Echo the sysadmin flag so the frontend can gate sysadmin-only sidebar
    // entries (Registry, Build Queue, All Users, All Organizations) via
    // isSystemAdmin(user).
    isSuperAdmin: user.isSuperAdmin === true,
    isEmailVerified: user.isEmailVerified,
    needsOnboarding: user.needsOnboarding === true,
    organizationId: user.lastActiveOrgId?.toString() || null,
    organizationName: opts?.activeOrgName || null,
    ...(opts?.organization && { organization: opts.organization }),
    ...(opts?.organizations && { organizations: opts.organizations }),
    ...(opts?.tier && { tier: opts.tier }),
    ...(opts?.features && { features: opts.features }),
    ...(opts?.permissions && { permissions: opts.permissions }),
    ...(user.featureOverrides && { featureOverrides: toOverridesRecord(user.featureOverrides) }),
    ...(user.createdAt && { createdAt: user.createdAt }),
    ...(user.updatedAt && { updatedAt: user.updatedAt }),
    ...(user.tokenVersion !== undefined && { tokenVersion: user.tokenVersion }),
  };
}
