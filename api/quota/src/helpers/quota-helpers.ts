// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, QUOTA_AUTOMATION_GRACE_PCT, QUOTA_TIERS, VALID_QUOTA_TYPES, enforcedQuotaLimit, nextQuotaResetDate } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaTier, QuotaReserveResult } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import type { QuotaLimits, QuotaUsageTracking, OrganizationDocument } from '../models/organization.js';

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

/**
 * The limit an org is held to on `quotaType` when its document stores NONE —
 * its TIER's preset, not the developer fallback. A newly added quota type
 * (`automationCalls`) reaches existing orgs this way: the platform seeds limits
 * only at creation, and billing writes the effective limit on the next
 * entitlement sync, so until then a Pro org must read Pro's number, not
 * Developer's. Unknown / missing tier ⇒ the unprovisioned-org default.
 */
export function defaultLimitFor(tier: string | undefined, quotaType: QuotaType): number {
  const preset = tier ? (QUOTA_TIERS as Partial<Record<string, { limits?: Partial<Record<QuotaType, number>> }>>)[tier] : undefined;
  return preset?.limits?.[quotaType] ?? config.quota.defaults[quotaType];
}

/**
 * {@link defaultLimitFor} as a Mongo aggregation expression over the matched
 * document's `$tier`, for the atomic increment filters — so a missing stored
 * limit coalesces to the same number there as in every read.
 */
export function defaultLimitExpr(quotaType: QuotaType): unknown {
  const branches = Object.keys(QUOTA_TIERS)
    .map((tier) => ({ tier, limit: defaultLimitFor(tier, quotaType) }))
    .map(({ tier, limit }) => ({ case: { $eq: ['$tier', tier] }, then: limit }));
  return { $switch: { branches, default: config.quota.defaults[quotaType] } };
}

/**
 * {@link enforcedQuotaLimit} as a Mongo aggregation expression over a limit
 * expression: the cap the atomic increment filters compare against. Identity
 * for every type without a soft band; for `automationCalls` a positive limit
 * becomes `floor(limit × (100 + QUOTA_AUTOMATION_GRACE_PCT) / 100)`, so the
 * filter and every status read agree on where the 429 starts. Callers keep
 * their own `limit == -1` (unlimited) branch on the RAW expression.
 */
export function enforcedLimitExpr(quotaType: QuotaType, limitExpr: unknown): unknown {
  if (enforcedQuotaLimit(quotaType, 100) === 100) return limitExpr;
  return {
    $cond: [
      { $gt: [limitExpr, 0] },
      { $floor: { $divide: [{ $multiply: [limitExpr, 100 + QUOTA_AUTOMATION_GRACE_PCT] }, 100] } },
      limitExpr,
    ],
  };
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

/**
 * Compute the status for a single quota type, handling reset-if-expired.
 * `allowed` binds on the ENFORCED limit (the `automationCalls` soft band, see
 * api-core `enforcedQuotaLimit`) when `quotaType` is given; `limit` and
 * `remaining` always report the nominal cap.
 */
export function computeQuotaStatus(
  limit: number,
  usage: { used: number; resetAt: Date },
  quotaType?: QuotaType,
): QuotaStatus {
  const now = new Date();
  const resetAt = new Date(usage.resetAt);
  const used = resetAt <= now ? 0 : usage.used;
  const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
  const allowed = limit === -1 || used < (quotaType ? enforcedQuotaLimit(quotaType, limit) : limit);

  return { limit, used, remaining, allowed, unlimited: limit === -1, resetAt: usage.resetAt };
}

/**
 * Whether a reservation was granted. Spelled out rather than passed as a bare
 * boolean because {@link buildReserveResult}'s last argument is otherwise
 * indistinguishable at the call site from the numbers before it — and the two
 * outcomes mean opposite things to every caller of `reserveQuota`.
 */
export type ReserveOutcome = 'allowed' | 'exceeded';

/**
 * Build a {@link QuotaReserveResult} from raw usage figures. Centralizes the
 * unlimited (`limit === -1` ⇒ remaining `-1`) logic and resetAt serialization
 * so the read-back blocks across increment/decrement can't drift.
 * `resetAt` accepts a Date or ISO string; `undefined` ⇒ omitted.
 */
export function buildReserveResult(
  quotaType: QuotaType,
  limit: number,
  used: number,
  resetAt: Date | string | undefined,
  outcome: ReserveOutcome,
): QuotaReserveResult {
  return {
    exceeded: outcome === 'exceeded',
    quota: {
      type: quotaType,
      limit,
      used,
      remaining: limit === -1 ? -1 : Math.max(0, limit - used),
      resetAt: resetAt ? new Date(resetAt).toISOString() : undefined,
    },
  };
}

// Org quota response — unified shape used by all endpoints

/** Per-type summary (status minus the internal `allowed` flag). */
type QuotaSummary = Omit<QuotaStatus, 'allowed'>;

/** Unified org-level response returned to all callers. */
export interface OrgQuotaResponse {
  orgId: string;
  name: string;
  slug: string;
  tier: QuotaTier;
  quotas: Record<QuotaType, QuotaSummary>;
  /**
   * Length of the usage period in days (`QUOTA_RESET_DAYS`). Every counter
   * rolls over on this one period, so the dashboard's "per N days" copy and its
   * usage forecast read it instead of assuming a month.
   */
  periodDays: number;
  isDefault?: boolean;
  /**
   * Present when the org belongs to an org → team pool (a root with teams, or a
   * team). `quotas` (except storageBytes) and `tier` are then the ROOT's pooled
   * caps against the whole subtree's usage. Absent for a flat org.
   */
  pool?: {
    rootOrgId: string;
    rootOrgName: string;
    /** True when this org IS the pool root (false ⇒ a team). */
    isRoot: boolean;
    /** Root + every team in the pool. */
    orgCount: number;
  };
}

/** Build the per-type quota summaries, falling back to config defaults. */
function buildSummaries(
  tier: string | undefined,
  quotas: Partial<QuotaLimits> | undefined,
  usage: Partial<QuotaUsageTracking> | undefined,
): Record<QuotaType, QuotaSummary> {
  const du = { used: 0, resetAt: nextQuotaResetDate(config.quota.resetDays) };

  // Drop the `allowed` flag from the per-type status — summaries are read-only views.
  const summarize = (limit: number, u: { used: number; resetAt: Date }): QuotaSummary => {
    const { allowed: _allowed, ...rest } = computeQuotaStatus(limit, u);
    return rest;
  };

  return Object.fromEntries(
    VALID_QUOTA_TYPES.map((t) => [t, summarize(quotas?.[t] ?? defaultLimitFor(tier, t), usage?.[t] ?? du)]),
  ) as Record<QuotaType, QuotaSummary>;
}

/**
 * Plain shape an org-quota response can be built from. Lets the service layer
 * pass either a hydrated mongoose document or a `.lean()` plain object without
 * tying this helper to Mongoose's document type.
 */
interface OrgQuotaSource {
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
    quotas: buildSummaries(org.tier, org.quotas, org.usage),
    periodDays: config.quota.resetDays,
  };
}

/** Build a default org quota response when the organization is not found. */
export function buildDefaultOrgQuotaResponse(orgId: string): OrgQuotaResponse {
  return {
    orgId,
    name: '',
    slug: '',
    tier: DEFAULT_TIER,
    quotas: buildSummaries(undefined, undefined, undefined),
    periodDays: config.quota.resetDays,
    isDefault: true,
  };
}
