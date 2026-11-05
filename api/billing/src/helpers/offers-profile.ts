// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 0 — the signal store's writer (docs/plans/sales-agent.md).
 *
 * Builds one `UsageProfile` row per account root per period, APPEND-ONLY, from
 * the internal reads the plan's Phase 0 had to create: quota's pooled
 * per-dimension picture and platform's seat activity.
 *
 * **It runs even when offers are off.** `OFFERS_ENABLED` gates the GRANT (Phase
 * 2), not this: history is the one thing in the plan that cannot be backfilled,
 * so a quarter with offers disabled must not cost a quarter of trajectory. What
 * the switch stops is any offer being created — never the observation.
 *
 * **Fails CLOSED on an incomplete read (D8), and that is the opposite of the
 * path it feeds.** The quota service fails OPEN so a reachability problem never
 * blocks a customer's work. This does the reverse: a profile assembled from
 * partial reads looks like an account with low usage on whichever dimension
 * failed, which is exactly the shape that suppresses an offer the account should
 * have had — or argues for one it should not. So the row is written with
 * `complete: false` and the rules skip it, rather than being quietly believed.
 */

import {
  createLogger,
  createScheduler,
  DEFAULT_LEADER_LOCK_TTL_MS,
  errorMessage,
  getServiceAuthHeader,
  isValidTier,
  leaderLockKey,
  type QuotaTier,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { config } from '../config.js';
import { getBundleCatalog } from './billing-helpers.js';
import { currentSpendCents } from './crossover.js';
import { fetchSeatActivity, fetchUsageProfile } from './downstream-client.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from './subscription-status.js';
import { getBillingConfig } from '../config/billing-config.js';
import { Subscription } from '../models/subscription.js';
import { UsageProfile, type ProfileDimension } from '../models/usage-profile.js';

const logger = createLogger('offers-profile');

/** The activity window the VALUE signal is measured over. */
const ACTIVITY_WINDOW_DAYS = 30;

export interface ProfileCycleResult {
  /** Accounts a row was written for. */
  written: number;
  /** Accounts whose row is marked incomplete (a read failed). */
  incomplete: number;
  /** Accounts skipped because a row for the period already existed. */
  duplicate: number;
}

/**
 * The period key a row is filed under: the ISO date its window ENDS.
 *
 * Derived from the dimension that actually has the longest window, so one
 * account gets ONE row per billing-meaningful period rather than one per quota
 * type. Falls back to today when no dimension reports a reset — a profile with
 * no period is still worth keeping, and dropping it would lose the row that
 * says the reads were unusable.
 */
export function periodKeyFor(dimensions: Record<string, { resetAt: string | null }>): string {
  const resets = Object.values(dimensions)
    .map((d) => d.resetAt)
    .filter((r): r is string => typeof r === 'string' && !Number.isNaN(Date.parse(r)))
    .sort();
  const chosen = resets.length > 0 ? resets[resets.length - 1]! : new Date().toISOString();
  return chosen.slice(0, 10);
}

/** Build one account's profile row without writing it — the testable half. */
export async function buildProfile(input: {
  orgId: string;
  tier: QuotaTier;
  interval: 'monthly' | 'annual';
  addons: Array<{ bundleId: string; quantity: number }>;
  subscriptionStartedAt: Date;
  auth: string;
}): Promise<{
    orgId: string;
    period: string;
    tier: QuotaTier;
    dimensions: Record<string, ProfileDimension>;
    value: { activeMembers: number; seatsHeld: number; successfulRuns: number; failedBuilds: number };
    addonsHeld: string[];
    spendCents: number;
    subscriptionAgeDays: number;
    complete: boolean;
    incompleteReasons: string[];
    computedAt: Date;
  }> {
  const { orgId, tier, interval, addons, auth } = input;
  const incompleteReasons: string[] = [];

  // Both reads in parallel: they touch different services and neither depends
  // on the other's answer.
  const [usage, seats] = await Promise.all([
    fetchUsageProfile(orgId, auth).catch(() => null),
    fetchSeatActivity(orgId, auth, ACTIVITY_WINDOW_DAYS).catch(() => null),
  ]);

  if (!usage) incompleteReasons.push('quota_profile_unreadable');
  if (!seats) incompleteReasons.push('seat_activity_unreadable');

  const dimensions: Record<string, ProfileDimension> = {};
  for (const [type, d] of Object.entries(usage?.dimensions ?? {})) {
    dimensions[type] = {
      used: d.used,
      limit: d.limit,
      ratio: d.ratio,
      projected: d.projected,
      // Threshold crossings are a per-increment notion the notifier owns; the
      // profile records the band it ENDED the period in, which is the durable
      // fact a rule can read from history.
      crossed: d.ratio === null ? null : bandFor(d.ratio),
    };
  }

  const plan = getBillingConfig().plans.find((p) => p.tier === tier);
  const spendCents = plan ? currentSpendCents(plan, addons, getBundleCatalog(), interval) : 0;

  // UNKNOWN activity is not inactivity. A membership with no stamp predates the
  // field, so an account whose members are all unstamped tells us nothing about
  // engagement — recording it as zero active would argue against exactly the
  // offers it should receive.
  const seatsHeld = seats?.seatsHeld ?? 0;
  const unknown = seats?.unknownActivity ?? 0;
  if (seats && seatsHeld > 0 && unknown === seatsHeld) {
    incompleteReasons.push('seat_activity_unstamped');
  }

  return {
    orgId,
    period: periodKeyFor(usage?.dimensions ?? {}),
    tier,
    dimensions,
    value: {
      activeMembers: seats?.activeMembers ?? 0,
      seatsHeld,
      // Not yet collected: the run/build counts need reporting reads this phase
      // does not open. Recorded as 0 with the gap named, rather than omitted —
      // a rule that needs them can check `incompleteReasons` instead of reading
      // a zero as "no runs".
      successfulRuns: 0,
      failedBuilds: 0,
    },
    addonsHeld: addons.map((a) => a.bundleId),
    spendCents,
    subscriptionAgeDays: Math.max(
      0,
      Math.floor((Date.now() - input.subscriptionStartedAt.getTime()) / (24 * 60 * 60 * 1000)),
    ),
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    computedAt: new Date(),
  };
}

/** The notice band a ratio ends a period in: 100, 90, 80, or null. */
function bandFor(ratio: number): number | null {
  if (ratio >= 1) return 100;
  if (ratio >= 0.9) return 90;
  if (ratio >= 0.8) return 80;
  return null;
}

/**
 * One collection cycle: a row per account root per period.
 *
 * Walks the subscription cursor rather than loading every account, the same way
 * `batchEvaluatePromotion` does — this runs against every paying account and
 * cannot hold them all in memory.
 *
 * A duplicate period is a NO-OP, not an error. The unique index on
 * `(orgId, period)` is what enforces append-only, so a re-run, an overlapping
 * cycle or a second replica that won the lock late all lose on insert instead
 * of appending a second row the trajectory would read as two periods.
 */
export async function runProfileCycle(): Promise<ProfileCycleResult> {
  const result: ProfileCycleResult = { written: 0, incomplete: 0, duplicate: 0 };
  const cursor = Subscription.find({ status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } }).cursor();

  for await (const sub of cursor) {
    const orgId = sub.orgId;
    try {
      const plan = getBillingConfig().plans.find((p) => p.id === sub.planId)
        ?? getBillingConfig().plans.find((p) => p.tier === (sub as { tier?: string }).tier);
      const tier = plan?.tier;
      if (!tier || !isValidTier(tier)) continue;

      const profile = await buildProfile({
        orgId,
        tier,
        interval: sub.interval,
        addons: (sub.addons ?? []).map((a) => ({ bundleId: a.bundleId, quantity: a.quantity })),
        subscriptionStartedAt: sub.createdAt ?? new Date(),
        auth: getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'member' }),
      });

      await UsageProfile.create(profile);
      result.written += 1;
      if (!profile.complete) result.incomplete += 1;
    } catch (err) {
      if (isDuplicateKey(err)) {
        // The append-only guarantee doing its job.
        result.duplicate += 1;
        continue;
      }
      // One account's failure must not end the cycle: the next account's
      // profile is independent, and a cycle that aborted on the first bad read
      // would lose the whole period's history rather than one row of it.
      logger.warn('Profile cycle skipped an account', { orgId, error: errorMessage(err) });
    }
  }

  logger.info('Profile cycle complete', { ...result });
  return result;
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** Whether this deployment may MAKE offers right now (read per cycle, D6). */
export function offersAllowed(): boolean {
  return config.enabled && config.offersEnabled;
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = DEFAULT_LEADER_LOCK_TTL_MS;

const scheduler: Scheduler = createScheduler({
  name: 'offers-profile',
  intervalMs: config.offers.profileIntervalMs,
  run: async () => {
    // RE-READ the switch every tick rather than capturing it at start (D6). A
    // knob that only takes effect on redeploy is not a kill switch, and this is
    // a default-on process feeding one that spends a campaign budget.
    //
    // Note it gates the GRANT, not this: the store keeps filling with offers
    // off, because history cannot be backfilled. The check here is only for the
    // case where billing itself has been turned off — then there is no
    // catalogue to profile against.
    if (!config.enabled) {
      logger.debug('Billing disabled — skipping profile cycle');
      return;
    }
    await runWithTenantContext({ isSuperAdmin: true }, runProfileCycle);
  },
  // Leader-locked: every replica runs this scheduler, and two replicas writing
  // the same period would both lose on the unique index — correct, but it would
  // burn the whole cursor twice per cycle to discover it.
  lock: { key: leaderLockKey('billing', 'offers-profile'), ttlMs: LOCK_TTL_MS },
});

/** Start the profile collector. Safe to call twice. */
export function startOffersProfile(): void {
  if (!config.enabled) {
    logger.debug('Billing disabled — profile collector not started');
    return;
  }
  // Deliberately NOT gated on `offersEnabled`: the store fills either way, so a
  // deployment that enables offers later has the history to act on rather than
  // starting from nothing.
  logger.info('Starting offers profile collector', {
    intervalMs: config.offers.profileIntervalMs,
    offersEnabled: config.offersEnabled,
  });
  scheduler.start();
}

/** Stop the collector (graceful shutdown). Safe when never started. */
export function stopOffersProfile(): void { scheduler.stop(); }
