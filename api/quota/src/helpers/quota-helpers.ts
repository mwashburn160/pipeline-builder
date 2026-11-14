// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, QUOTA_TIERS, VALID_QUOTA_TYPES, enforcedQuotaLimit, quotaGracePct, nextQuotaResetDate, quotaPeriodDays } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaTier, QuotaReserveResult } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import type { QuotaLimits, QuotaUsageTracking, OrganizationDocument } from '../models/organization.js';

/**
 * The usage period for one quota type, in days — the ONE spelling of the rule
 * every reset date, period summary and default window in this service reads.
 *
 * `config.quota.resetDays` is the GLOBAL window and is correct for every flow
 * quota but `cpuCredits`, which is monthly (api-core `quotaPeriodDays`). Reading
 * the global for credits gave them ten resets a month against a cap sized for
 * one — a factor-of-ten error in the customer's favour, and silent, because a
 * counter that rolls too often never refuses anything. The rule was spelled
 * inline in five places before; one of them drifting is that bug again.
 */
export function periodDaysFor(quotaType: QuotaType): number {
  return quotaType === 'cpuCredits' ? quotaPeriodDays(quotaType) : config.quota.resetDays;
}

/**
 * CAPS ONLY RISE MID-PERIOD: the cap a LIVE period binds on is the larger of
 * the limit it started with (`snapshot`, captured at the period boundary) and
 * the limit the account holds now, with -1 (unlimited) on either side winning.
 * `snapshot === undefined` (no live period, or a counter that predates the
 * field) is the current limit.
 *
 * One definition for every reader — the per-org status, the pooled status, and
 * (as {@link effectiveLimitExpr}) the atomic increment filters — so the read
 * that says "allowed" and the write that reserves can never disagree.
 */
export function effectiveLimit(limit: number, snapshot: number | undefined): number {
  if (snapshot === undefined || snapshot === null) return limit;
  if (limit === -1 || snapshot === -1) return -1;
  return Math.max(limit, snapshot);
}

/**
 * {@link effectiveLimit} as a Mongo aggregation expression, for a LIVE period:
 * `limitExpr` is the current limit, `snapshotPath` the counter's
 * `limitAtPeriodStart` field path (`$usage.<type>.limitAtPeriodStart`). An
 * absent or non-numeric snapshot is the current limit.
 */
export function effectiveLimitExpr(limitExpr: unknown, snapshotPath: string): unknown {
  return {
    $cond: {
      if: { $not: [{ $isNumber: snapshotPath }] },
      then: limitExpr,
      else: {
        $cond: {
          if: { $or: [{ $eq: [limitExpr, -1] }, { $eq: [snapshotPath, -1] }] },
          then: -1,
          else: { $max: [limitExpr, snapshotPath] },
        },
      },
    },
  };
}

/**
 * The at-risk percentage of one status: `used / limit`, rounded and capped at
 * 100. A 0 limit is permanently at risk (any use is 100%+), so it reports 100.
 * Callers skip unlimited statuses first. Shared by the cross-org scan and the
 * per-org at-risk route so the two report the same figure.
 */
export function atRiskPercent(status: { used: number; limit: number }): number {
  return status.limit === 0 ? 100 : Math.min(100, Math.round((status.used / status.limit) * 100));
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
 * `enforcedQuotaLimit` as a Mongo aggregation expression over a limit
 * expression: the cap the atomic increment filters compare against. Identity
 * for every type without a soft band; for a BANDED type a positive limit
 * becomes `floor(limit × (100 + pct) / 100)`, so the filter and every status
 * read agree on where the 429 starts. Callers keep their own `limit == -1`
 * (unlimited) branch on the RAW expression.
 *
 * The percentage is {@link quotaGracePct} for THIS type. It used to be
 * `QUOTA_AUTOMATION_GRACE_PCT` inlined, which was right only while automation
 * was the sole banded type — the moment a second one existed (storage), this
 * expression would have applied automation's percentage to it.
 */
export function enforcedLimitExpr(quotaType: QuotaType, limitExpr: unknown): unknown {
  const pct = quotaGracePct(quotaType);
  if (pct <= 0) return limitExpr;
  return {
    $cond: [
      { $gt: [limitExpr, 0] },
      { $floor: { $divide: [{ $multiply: [limitExpr, 100 + pct] }, 100] } },
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
  usage: { used: number; resetAt: Date; limitAtPeriodStart?: number },
  quotaType?: QuotaType,
): QuotaStatus {
  const now = new Date();
  const resetAt = new Date(usage.resetAt);
  const expired = resetAt <= now;
  const used = expired ? 0 : usage.used;

  // CAPS ONLY RISE MID-PERIOD. The effective cap is the larger of what the
  // period started with and what the account holds now, so a downgrade or a
  // cancelled pack takes effect from the NEXT window while a mid-period UPGRADE
  // still lands immediately.
  //
  // This is what makes `checkEntitlementOvercap`'s exclusion of per-period rate
  // quotas honest again. Its stated reason — "they reset, so landing over a
  // reduced cap costs at most one period" — holds at three days and breaks at a
  // month: without this, a mid-month downgrade or a cancelled CPU Credits Pack
  // could refuse every build until the window rolled. One policy line here is
  // cheaper than a guard entry per dimension, and it needs no scheduled
  // plan-change machinery (of which the billing service has none).
  //
  // An EXPIRED period takes the current limit: the new window starts at whatever
  // the account holds, which is how a reduction eventually applies.
  const effective = effectiveLimit(limit, expired ? undefined : usage.limitAtPeriodStart);

  const remaining = effective === -1 ? -1 : Math.max(0, effective - used);
  const allowed = effective === -1 || used < (quotaType ? enforcedQuotaLimit(quotaType, effective) : effective);

  return { limit: effective, used, remaining, allowed, unlimited: effective === -1, resetAt: usage.resetAt };
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

/**
 * A read-only per-type summary: the status without the enforcement flag, plus
 * the type's OWN usage period.
 *
 * `periodDays` lives here rather than only on the response because the period is
 * per type now — every flow quota shares `QUOTA_RESET_DAYS` except `cpuCredits`,
 * which is monthly. The dashboard's reset copy and its burn-rate forecast read
 * this; reading the org-level figure would be wrong by a factor of ten for
 * credits, which is the one dimension whose forecast matters most.
 */
export type QuotaSummary = Omit<QuotaStatus, 'allowed'> & { periodDays: number };

/**
 * A status as a read-only summary: drop the enforcement flag and attach the
 * type's own period. The one conversion every summary goes through — the
 * per-org builder and the pooled overlay (live and cached) alike — so the
 * pooled path cannot forget `periodDays`, which it builds by hand otherwise.
 */
export function toQuotaSummary(quotaType: QuotaType, status: QuotaStatus): QuotaSummary {
  const { allowed: _allowed, ...rest } = status;
  return { ...rest, periodDays: periodDaysFor(quotaType) };
}

/** Unified org-level response returned to all callers. */
export interface OrgQuotaResponse {
  orgId: string;
  name: string;
  slug: string;
  tier: QuotaTier;
  quotas: Record<QuotaType, QuotaSummary>;
  /**
   * Length of the usage period in days, for the quotas that share the GLOBAL
   * window (`QUOTA_RESET_DAYS`).
   *
   * Kept for the org-level "per N days" copy, but it is no longer the whole
   * story and must not be used to compute a reset date or a forecast: each
   * summary in `quotas` now carries its OWN `periodDays`, because `cpuCredits`
   * rolls monthly. A forecast computed from this figure is wrong by a factor of
   * ten for that one dimension — read the summary's, not this.
   */
  periodDays: number;
  isDefault?: boolean;
  /**
   * Present when the org belongs to an org → team pool (a root with teams, or a
   * team). `quotas` and `tier` are then the ROOT's pooled caps against the
   * whole subtree's usage — for `storageBytes`, the subtree's measured registry
   * total (`fillStorageUsage`). Absent for a flat org.
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
  // Per TYPE, not one shared fallback: `cpuCredits` is monthly and every other
  // flow is on the global window, so a single default would report a credits
  // reset date ten times too near — and the dashboard's burn-rate forecast reads
  // exactly that date.
  const defaultUsage = (t: QuotaType) => ({ used: 0, resetAt: nextQuotaResetDate(periodDaysFor(t)) });

  return Object.fromEntries(
    VALID_QUOTA_TYPES.map((t) => [t, toQuotaSummary(t, computeQuotaStatus(quotas?.[t] ?? defaultLimitFor(tier, t), usage?.[t] ?? defaultUsage(t)))]),
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
