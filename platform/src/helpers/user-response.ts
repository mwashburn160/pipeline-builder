// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The user object the profile and admin user APIs return. */

import type { FeatureFlag, PlanTier } from '@pipeline-builder/api-core';
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
  createdAt?: Date;
  updatedAt?: Date;
  tokenVersion?: number;
}

/** One org's flag → on/off overrides, as stored (hydrated Map) or read (`.lean()` object). */
type OverrideSet = Map<string, boolean> | Record<string, boolean>;

/**
 * The stored `User.featureOverrides` value: organization id → that org's
 * overrides. A hydrated document yields nested Maps; a `.lean()` read yields
 * nested plain objects. Both shapes are accepted.
 */
export type StoredFeatureOverrides = Map<string, OverrideSet> | Record<string, OverrideSet>;

/**
 * The feature overrides that apply in ONE organization, as a plain record.
 *
 * Overrides are per-org (an org admin's grant/revoke must never reach the
 * user's other orgs), so every reader — token minting, profile, admin view —
 * resolves only the entry for the org it is answering for. Returns `undefined`
 * when there is no org or no entry for it.
 */
export function orgFeatureOverrides(
  stored: StoredFeatureOverrides | null | undefined,
  orgId: string | null | undefined,
): Record<string, boolean> | undefined {
  if (!stored || !orgId) return undefined;
  const entry = stored instanceof Map ? stored.get(orgId) : stored[orgId];
  if (!entry) return undefined;
  return entry instanceof Map ? Object.fromEntries(entry) : { ...entry };
}

/** Build a standardized user response object for API output. */
export function formatUserResponse(
  user: UserResponseInput,
  opts?: {
    activeOrgRole?: string;
    activeOrgName?: string | null;
    organization?: OrgSummary;
    organizations?: OrgMembership[];
    tier?: PlanTier;
    features?: FeatureFlag[];
    /** Effective fine-grained permissions for the active org (RBAC UI gating). */
    permissions?: string[];
    /** The feature overrides for the ONE org this response describes — never
     *  the raw per-org map, which would expose other orgs' settings. */
    featureOverrides?: Record<string, boolean>;
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
    ...(opts?.featureOverrides && { featureOverrides: opts.featureOverrides }),
    ...(user.createdAt && { createdAt: user.createdAt }),
    ...(user.updatedAt && { updatedAt: user.updatedAt }),
    ...(user.tokenVersion !== undefined && { tokenVersion: user.tokenVersion }),
  };
}
