// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createSafeClient, getServiceAuthHeader } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { config } from '../config';
import { getBillingTimeout } from './billing-helpers';

const logger = createLogger('usage-helpers');

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
  /** Cost breakdown for the active period. Flat-rate today (no metered overages). */
  cost: {
    subscriptionCents: number;
    /** Currency code. Hard-coded USD until multi-currency lands. */
    currency: 'USD';
  };
}

/** Shape of `data.quota` returned by GET /quotas/:orgId. */
interface QuotaSnapshot {
  tier: QuotaTier;
  quotas: Record<string, number>;
  usage: Record<string, { used: number; resetAt: string }>;
  name?: string;
  slug?: string;
}

/**
 * Fetch the org's full quota snapshot (limits + usage) in a single round-trip.
 *
 * Mirrors `syncTierToQuotaService`'s client construction so the timeout /
 * host config stays consistent. Returns null on transport / parse failure
 * — the rollup endpoint treats that as "no quota data available" rather
 * than failing the whole response, since the subscription side is still
 * meaningful on its own.
 */
async function fetchQuotaSnapshot(orgId: string, authHeader: string): Promise<QuotaSnapshot | null> {
  const client = createSafeClient({
    host: config.quotaService.host,
    port: config.quotaService.port,
    timeout: getBillingTimeout(),
  });

  const effectiveAuth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'member' });
  const response = await client.get<{
    success: boolean;
    data?: { quota?: QuotaSnapshot };
  }>(`/quotas/${encodeURIComponent(orgId)}`, {
    headers: { 'Authorization': effectiveAuth, 'x-org-id': orgId },
  });

  if (!response || response.statusCode !== 200 || !response.body?.success) {
    logger.warn('Quota snapshot fetch failed', { orgId, statusCode: response?.statusCode });
    return null;
  }
  return response.body.data?.quota ?? null;
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
): UsageRollup {
  // Period: prefer the subscription's window. If there's no active sub
  // (free / unsubscribed orgs), default to a 30-day window anchored at now
  // so the UI can still show usage progress against the developer-tier caps.
  // Fallback window for orgs with no active subscription. Default 30 days
  // either side gives free-tier orgs a recognizable "this month / next month"
  // shape on the dashboard. Override via `BILLING_USAGE_FALLBACK_DAYS`.
  const fallbackDays = parseInt(process.env.BILLING_USAGE_FALLBACK_DAYS || '30', 10);
  const MS_PER_DAY = 24 * 3600_000;
  const periodStart = subscription?.currentPeriodStart ?? new Date(now.getTime() - fallbackDays * MS_PER_DAY);
  const periodEnd = subscription?.currentPeriodEnd ?? new Date(now.getTime() + fallbackDays * MS_PER_DAY);
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
      const limit = quotaSnapshot.quotas[key] ?? -1;
      const usageRow = quotaSnapshot.usage?.[key] ?? { used: 0, resetAt: new Date().toISOString() };
      usage[key] = toUsageEntry(limit, usageRow.used, usageRow.resetAt);
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
): Promise<UsageRollup> {
  const snapshot = await fetchQuotaSnapshot(orgId, authHeader);
  return buildUsageRollup(subscription, plan, snapshot);
}
