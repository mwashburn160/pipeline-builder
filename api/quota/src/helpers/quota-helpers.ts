// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, VALID_QUOTA_TYPES } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaTier } from '@pipeline-builder/api-core';
export type { QuotaTier } from '@pipeline-builder/api-core';
export { QUOTA_TIERS, VALID_TIERS, VALID_QUOTA_TYPES, isValidQuotaType } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import type { QuotaLimits, QuotaUsageTracking, OrganizationDocument } from '../models/organization.js';
export { toOrgId } from './org-id.js';

// Date helpers

/** Calculate the next reset date based on days from now (midnight). */
export function getNextResetDate(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Apply partial quota limit updates to an organization document.
 * Only sets fields that are explicitly provided (not undefined).
 */
export function applyQuotaLimits(
  org: OrganizationDocument,
  updates: Partial<Record<QuotaType, number>>,
): void {
  for (const key of VALID_QUOTA_TYPES) {
    if (updates[key] !== undefined) org.quotas[key] = updates[key]!;
  }
}

// Quota status (per-type)

/** Per-quota-type status with usage and limit info. */
export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  allowed: boolean;
  unlimited: boolean;
  resetAt: Date;
}

/** Compute the status for a single quota type, handling reset-if-expired. */
export function computeQuotaStatus(
  limit: number,
  usage: { used: number; resetAt: Date },
): QuotaStatus {
  const now = new Date();
  const resetAt = new Date(usage.resetAt);
  const used = resetAt <= now ? 0 : usage.used;
  const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
  const allowed = limit === -1 || used < limit;

  return { limit, used, remaining, allowed, unlimited: limit === -1, resetAt: usage.resetAt };
}

// Org quota response — unified shape used by all endpoints

/** Per-type summary (status minus the internal `allowed` flag). */
export type QuotaSummary = Omit<QuotaStatus, 'allowed'>;

/** Unified org-level response returned to all callers. */
export interface OrgQuotaResponse {
  orgId: string;
  name: string;
  slug: string;
  tier: QuotaTier;
  quotas: Record<QuotaType, QuotaSummary>;
  isDefault?: boolean;
}

/** Build all three quota summaries, falling back to config defaults. */
function buildSummaries(
  quotas: Partial<QuotaLimits> | undefined,
  usage: Partial<QuotaUsageTracking> | undefined,
): Record<QuotaType, QuotaSummary> {
  const d = config.quota.defaults;
  const du = { used: 0, resetAt: getNextResetDate(config.quota.resetDays) };

  // Drop the `allowed` flag from the per-type status — summaries are read-only views.
  const summarize = (limit: number, u: { used: number; resetAt: Date }): QuotaSummary => {
    const { allowed: _allowed, ...rest } = computeQuotaStatus(limit, u);
    return rest;
  };

  return {
    plugins: summarize(quotas?.plugins ?? d.plugins, usage?.plugins ?? du),
    pipelines: summarize(quotas?.pipelines ?? d.pipelines, usage?.pipelines ?? du),
    apiCalls: summarize(quotas?.apiCalls ?? d.apiCalls, usage?.apiCalls ?? du),
    aiCalls: summarize(quotas?.aiCalls ?? d.aiCalls, usage?.aiCalls ?? du),
    storageBytes: summarize(quotas?.storageBytes ?? d.storageBytes, usage?.storageBytes ?? du),
    dashboards: summarize(quotas?.dashboards ?? d.dashboards, usage?.dashboards ?? du),
    alertRules: summarize(quotas?.alertRules ?? d.alertRules, usage?.alertRules ?? du),
    alertDestinations: summarize(quotas?.alertDestinations ?? d.alertDestinations, usage?.alertDestinations ?? du),
    idpConfigs: summarize(quotas?.idpConfigs ?? d.idpConfigs, usage?.idpConfigs ?? du),
  };
}

/**
 * Plain shape an org-quota response can be built from. Lets the service layer
 * pass either a hydrated mongoose document or a `.lean()` plain object without
 * tying this helper to Mongoose's document type.
 */
export interface OrgQuotaSource {
  _id: unknown;
  name: string;
  slug: string;
  tier?: QuotaTier;
  quotas?: Partial<QuotaLimits>;
  usage?: Partial<QuotaUsageTracking>;
}

/** Build an org quota response from a plain org-shape object. */
export function buildOrgQuotaResponse(org: OrgQuotaSource): OrgQuotaResponse {
  return {
    orgId: String(org._id),
    name: org.name,
    slug: org.slug,
    tier: org.tier || DEFAULT_TIER,
    quotas: buildSummaries(org.quotas, org.usage),
  };
}

/** Build a default org quota response when the organization is not found. */
export function buildDefaultOrgQuotaResponse(orgId: string): OrgQuotaResponse {
  return {
    orgId,
    name: '',
    slug: '',
    tier: DEFAULT_TIER,
    quotas: buildSummaries(undefined, undefined),
    isDefault: true,
  };
}
