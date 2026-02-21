/**
 * @module helpers/quota-helpers
 * @description Shared domain logic for quota operations.
 *
 * Centralises reset-date arithmetic, default responses, quota-type
 * validation, error helpers, and response building.
 */

import { sendError, ErrorCode, DEFAULT_TIER, VALID_QUOTA_TYPES } from '@mwashburn160/api-core';
import type { QuotaType, QuotaTier } from '@mwashburn160/api-core';
export type { QuotaTier, QuotaTierPreset, QuotaTierLimits } from '@mwashburn160/api-core';
export { QUOTA_TIERS, VALID_TIERS, DEFAULT_TIER, isValidTier, getTierLimits, VALID_QUOTA_TYPES, isValidQuotaType } from '@mwashburn160/api-core';
import { Response } from 'express';
import { config } from '../config';
import { IOrganization, QuotaLimits, QuotaUsageTracking } from '../models/organization';

/** Shared auth options — allow x-org-id header override for service-to-service calls. */
export const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Calculate the next reset date based on days from now (midnight). */
export function getNextResetDate(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate quota limit values from a request body.
 * Returns an array of validation error strings (empty = valid).
 */
export function validateQuotaValues(
  body: Partial<Record<QuotaType, unknown>>,
): string[] {
  const errors: string[] = [];

  for (const key of VALID_QUOTA_TYPES) {
    const val = body[key];
    if (val === undefined) continue;

    if (typeof val !== 'number' || (!Number.isInteger(val) && val !== -1)) {
      errors.push(`${key} must be an integer or -1 for unlimited`);
    } else if ((val as number) < -1) {
      errors.push(`${key} must be -1 (unlimited) or a non-negative integer`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Send a 404 "organization not found" response. */
export function sendOrgNotFound(res: Response): void {
  sendError(res, 404, 'Organization not found.', ErrorCode.ORG_NOT_FOUND);
}

/** Send a 400 "invalid quota type" response. */
export function sendInvalidQuotaType(res: Response): void {
  sendError(
    res, 400,
    `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`,
    ErrorCode.VALIDATION_ERROR,
  );
}

/** Send a 400 "missing org ID" response. */
export function sendMissingOrgId(res: Response): void {
  sendError(
    res, 400,
    'Organization ID is required. Please provide x-org-id header.',
    ErrorCode.MISSING_REQUIRED_FIELD,
  );
}

/**
 * Apply partial quota limit updates to an organization document.
 * Only sets fields that are explicitly provided (not undefined).
 */
export function applyQuotaLimits(
  org: IOrganization,
  updates: Partial<Record<QuotaType, number>>,
): void {
  for (const key of VALID_QUOTA_TYPES) {
    if (updates[key] !== undefined) org.quotas[key] = updates[key]!;
  }
}

// ---------------------------------------------------------------------------
// Quota status (per-type)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Org quota response — unified shape used by all endpoints
// ---------------------------------------------------------------------------

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

/** Compute a single quota summary. */
function toSummary(
  limit: number,
  usage: { used: number; resetAt: Date },
): QuotaSummary {
  const { allowed: _, ...rest } = computeQuotaStatus(limit, usage);
  return rest;
}

/** Build all three quota summaries, falling back to config defaults. */
function buildSummaries(
  quotas: Partial<QuotaLimits> | undefined,
  usage: Partial<QuotaUsageTracking> | undefined,
): Record<QuotaType, QuotaSummary> {
  const d = config.quota.defaults;
  const du = { used: 0, resetAt: getNextResetDate(config.quota.resetDays) };

  return {
    plugins: toSummary(quotas?.plugins ?? d.plugins, usage?.plugins ?? du),
    pipelines: toSummary(quotas?.pipelines ?? d.pipelines, usage?.pipelines ?? du),
    apiCalls: toSummary(quotas?.apiCalls ?? d.apiCalls, usage?.apiCalls ?? du),
  };
}

/** Build an org quota response from a database document. */
export function buildOrgQuotaResponse(org: IOrganization): OrgQuotaResponse {
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
