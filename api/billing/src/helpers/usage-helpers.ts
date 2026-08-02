// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getServiceAuthHeader } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { fetchQuotaSnapshot, fetchSeatUsage, type QuotaSnapshot } from './quota-client.js';

/** Per-quota-type usage entry returned by the rollup. */
export interface UsageEntry {
  /** Current consumption in the active period. Bytes for `storageBytes`, count for others. */
  used: number;
  /** Cap from the org's tier (or operator override). -1 means unlimited. */
  limit: number;
  /** Remaining headroom. `null` when limit is unlimited. */
  remaining: number | null;
  /** 0..100, clamped. `null` when limit is unlimited. */
  percentOfLimit: number | null;
  /** When the counter next resets (period rollover). */
  resetAt: string;
}

/**
 * Pooled seat usage for the account (root), sourced from platform.
 * `limit` is -1 for unlimited. `null` on the rollup when the platform
 * read fails (fail-soft — the rest of the rollup still returns).
 */
export interface SeatUsage {
  /** Current pooled seat consumption across the account subtree. */
  used: number;
  /** Seat cap from tier + seat-pack add-ons. -1 means unlimited. */
  limit: number;
}

/** Shape of the GET /billing/usage response. */
export interface UsageRollup {
  /** Current billing period, derived from the active subscription. */
  period: {
    start: string;
    end: string;
    /** Whole days elapsed since `start` (rounded down). */
    daysElapsed: number;
    /** Whole days remaining until `end` (rounded down). 0 on the last day. */
    daysRemaining: number;
  };
  /** Active subscription summary. Null when the org has no active subscription. */
  subscription: {
    planId: string;
    planName: string;
    tier: QuotaTier;
    interval: 'monthly' | 'annual';
    priceCents: number;
  } | null;
  /** Per-quota usage. Keys mirror `QuotaType`. */
  usage: Record<string, UsageEntry>;
  /**
   * Pooled seat usage for the account. Seats are the primary Team
   * differentiator (raised by seat-pack add-ons) but are NOT a quota type,
   * so they're sourced separately from platform. `null` when the platform
   * seat-usage read failed — the dashboard renders the rest of the rollup
   * rather than failing the whole page.
   */
  seats: SeatUsage | null;
  /** Cost breakdown for the active period. Flat-rate today (no metered overages). */
  cost: {
    subscriptionCents: number;
    /** Currency code. Hard-coded USD until multi-currency lands. */
    currency: 'USD';
  };
}

/** Build a single UsageEntry from a (limit, used, resetAt) triple. */
function toUsageEntry(limit: number, used: number, resetAt: Date | string | undefined): UsageEntry {
  const isUnlimited = limit < 0;
  const remaining = isUnlimited ? null : Math.max(0, limit - used);
  const percent = isUnlimited ? null : (limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)));
  const reset = resetAt
    ? (typeof resetAt === 'string' ? resetAt : resetAt.toISOString())
    : new Date().toISOString();
  return { used, limit, remaining, percentOfLimit: percent, resetAt: reset };
}

/**
 * Combine subscription + quota snapshot into a flat cost/usage payload for
 * the dashboard. The result is dashboard-ready; the route handler just
 * serializes it.
 *
 * Inputs are pre-fetched by the caller so this helper stays pure / testable.
 */
export function buildUsageRollup(
  subscription: {
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    interval: 'monthly' | 'annual';
    planId: string;
  } | null,
  plan: { name: string; tier: QuotaTier; prices: { monthly: number; annual: number } } | null,
  quotaSnapshot: QuotaSnapshot | null,
  now: Date = new Date(),
  seats: SeatUsage | null = null,
  // Caller-supplied display window (from the UI's editable period start/end).
  // Highest priority for the DISPLAYED period + day math; the consumable usage
  // rows still come from the live current-period quota snapshot (the quota
  // service tracks only the current period), so an override reframes the window
  // shown, not the counts. Absent fields fall through to the subscription/fallback.
  periodOverride: { start?: Date; end?: Date } | null = null,
): UsageRollup {
  // Period precedence: explicit override → subscription window → fallback. If
  // there's no active sub (free / unsubscribed orgs) and no override, default to
  // a 30-day window anchored at now so the UI can still show usage progress
  // against the developer-tier caps. Default 30 days either side gives free-tier
  // orgs a recognizable "this month / next month" shape. Override the fallback
  // width via `BILLING_USAGE_FALLBACK_DAYS`.
  const fallbackDays = parseInt(process.env.BILLING_USAGE_FALLBACK_DAYS || '30', 10);
  const MS_PER_DAY = 24 * 3600_000;
  const periodStart = periodOverride?.start ?? subscription?.currentPeriodStart ?? new Date(now.getTime() - fallbackDays * MS_PER_DAY);
  const periodEnd = periodOverride?.end ?? subscription?.currentPeriodEnd ?? new Date(now.getTime() + fallbackDays * MS_PER_DAY);
  const daysElapsed = Math.max(0, Math.floor((now.getTime() - periodStart.getTime()) / MS_PER_DAY));
  const daysRemaining = Math.max(0, Math.floor((periodEnd.getTime() - now.getTime()) / MS_PER_DAY));

  const subSummary = subscription && plan ? {
    planId: subscription.planId,
    planName: plan.name,
    tier: plan.tier,
    interval: subscription.interval,
    priceCents: subscription.interval === 'annual' ? plan.prices.annual : plan.prices.monthly,
  } : null;

  // Usage rows — keyed by QuotaType. We iterate over the quota snapshot's
  // own keys so any future quota type the quota service ships gets surfaced
  // without a billing-side code change.
  const usage: Record<string, UsageEntry> = {};
  if (quotaSnapshot) {
    for (const key of Object.keys(quotaSnapshot.quotas)) {
      // Each entry is a QuotaSummary object `{ limit, used, resetAt, ... }` — NOT
      // a bare number. The old code treated the value as the limit and read a
      // non-existent sibling `usage` map, so `limit` became the whole object
      // (→ NaN in toUsageEntry) and `used` was hardcoded 0.
      const summary = quotaSnapshot.quotas[key];
      usage[key] = toUsageEntry(summary?.limit ?? -1, summary?.used ?? 0, summary?.resetAt);
    }
  }

  return {
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
      daysElapsed,
      daysRemaining,
    },
    subscription: subSummary,
    usage,
    seats,
    cost: {
      subscriptionCents: subSummary?.priceCents ?? 0,
      currency: 'USD',
    },
  };
}

/** Convenience wrapper used by the route — fetches the quota snapshot then builds. */
export async function buildUsageRollupFor(
  orgId: string,
  authHeader: string,
  subscription: Parameters<typeof buildUsageRollup>[0],
  plan: Parameters<typeof buildUsageRollup>[1],
  periodOverride: { start?: Date; end?: Date } | null = null,
): Promise<UsageRollup> {
  // Fetch the quota snapshot (core payload) and pooled seat usage (enrichment)
  // in parallel. Seat usage lives on platform, not the quota service, because
  // seats deliberately aren't a quota type. Either can fail-soft to null.
  // Mint the billing→service auth once (member scope) and thread it to both
  // shared readers, matching the old per-fetch minting.
  const auth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'member' });
  const [snapshot, seatSnapshot] = await Promise.all([
    fetchQuotaSnapshot(orgId, auth),
    fetchSeatUsage(orgId, auth),
  ]);
  // The rollup's `seats` field requires BOTH numeric (the dashboard shows
  // used/limit); a partial/failed read degrades to null (seats omitted).
  const seats = seatSnapshot && seatSnapshot.limit !== null && seatSnapshot.used !== null
    ? { limit: seatSnapshot.limit, used: seatSnapshot.used }
    : null;
  return buildUsageRollup(subscription, plan, snapshot, new Date(), seats, periodOverride);
}
