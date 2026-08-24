// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createEnvRedisLock, createLogger, createScheduler, type Scheduler } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { config } from '../config.js';
import { createBillingEvent } from './billing-helpers.js';
import { recordMarketplaceConsumption } from './billing-ledger.js';
import { grantPeriodicCredits } from './discount-helpers.js';
import { billingPeriodKey } from './billing-period.js';
import { planMeteredDrawdown } from './marketplace-credit.js';
import { grantRecurringPromotions } from './promotion-engine.js';
import { Subscription } from '../models/subscription.js';
import { AWSMarketplaceProvider, type MeterUsageResult } from '../providers/aws-marketplace-provider.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { getAuditClient } from '../services/audit.js';

const logger = createLogger('marketplace-metering');

/** ISO hour bucket — matches AWS BatchMeterUsage's (customer, dimension, hour) dedupe. */
function hourKeyFor(now: Date): string {
  return now.toISOString().slice(0, 13); // e.g. 2026-07-29T14
}

/** UTC bounds of the current billing period — used for the per-period consumption
 *  BillingInvoice row (`YYYY-MM` → that calendar month; `YYYY` → that year). */
function periodBounds(interval: string, now: Date): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  if (interval === 'annual') {
    return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  }
  const m = now.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

/** Why a metering report was skipped, or the result when it ran. */
export type MeteringOutcome =
  | { status: 'skipped'; reason: 'not-marketplace' | 'no-subscription' | 'no-customer' | 'no-addons' | 'provider-mismatch' }
  | { status: 'metered'; result: MeterUsageResult }
  | { status: 'error'; error: string };

/**
 * Report an account's current add-on quantities to AWS Marketplace as metered
 * usage (docs/billing-bundles.md §8; the Marketplace counterpart to Stripe's
 * line-item add-ons). Resolves the account's Marketplace customer + add-on set
 * and hands off to {@link AWSMarketplaceProvider.meterAddonUsage}.
 *
 * Best-effort and idempotent-ish: AWS BatchMeterUsage dedupes records by
 * (customer, dimension, hour), so re-reporting within the same hour is safe.
 * Driven on a CADENCE — NOT synchronously on an add-on mutation, since
 * Marketplace add-ons are not self-service in-app. The cadence driver is the
 * `marketplace-metering` scheduler (via {@link reportAllMarketplaceAddonUsage},
 * started by {@link startMarketplaceMetering} and gated on
 * `BILLING_METERING_ENABLED`); this helper is the per-account unit it calls.
 *
 * @param orgId The account (root) org whose add-on usage to report.
 */
export async function reportMarketplaceAddonUsage(orgId: string, now: Date = new Date()): Promise<MeteringOutcome> {
  if (config.billingProvider !== 'aws-marketplace') {
    return { status: 'skipped', reason: 'not-marketplace' };
  }

  let subscription = await Subscription.findOne({ orgId, status: 'active' });
  if (!subscription) return { status: 'skipped', reason: 'no-subscription' };

  const customerId = (subscription.metadata?.awsCustomerIdentifier as string | undefined)
    ?? subscription.externalCustomerId
    ?? undefined;
  if (!customerId) return { status: 'skipped', reason: 'no-customer' };

  if ((subscription.addons ?? []).length === 0) return { status: 'skipped', reason: 'no-addons' };

  const provider = getPaymentProvider();
  if (!(provider instanceof AWSMarketplaceProvider)) {
    // Provider config and billingProvider disagree — don't guess.
    return { status: 'skipped', reason: 'provider-mismatch' };
  }

  // Credits realize on Marketplace only when both switches are on (see the
  // provider's usageCreditSupport invariant). Multi-pod safety comes from the
  // atomic conditional claims below — NOT a leader lock — so only one pod ever
  // re-grants a given period or draws down a given hour.
  const creditsActive = config.marketplace.creditsEnabled && config.marketplace.meteringEnabled;
  const { bundleToDimensionMap, dimensionPriceMap, drawdownDryRun } = config.marketplace;

  // 1. Re-grant recurring + combo credits once per billing period (atomic claim).
  if (creditsActive) {
    const periodKey = billingPeriodKey(subscription.interval, now);
    const claimed = await Subscription.findOneAndUpdate(
      { '_id': subscription._id, 'metadata.lastCreditPeriod': { $ne: periodKey } },
      { $set: { 'metadata.lastCreditPeriod': periodKey } },
      { new: true },
    );
    if (claimed) {
      // Won the period — re-grant onto the freshly-claimed doc and persist. If the
      // grant/save fails, COMPENSATE the claim (unset the marker) so a later cycle
      // retries instead of permanently losing this period's credit.
      try {
        await grantPeriodicCredits(claimed, periodKey);
        // Recurring PROMOTIONS re-grant on the same period key (Marketplace parity
        // with the Stripe invoice path) — in-memory, persisted by the save below.
        await grantRecurringPromotions(claimed, periodKey);
        await claimed.save();
        subscription = claimed;
      } catch (err) {
        await Subscription.findOneAndUpdate(
          { '_id': subscription._id, 'metadata.lastCreditPeriod': periodKey },
          { $unset: { 'metadata.lastCreditPeriod': '' } },
        ).catch(() => undefined);
        throw err;
      }
    } else {
      // Another pod / earlier cycle already granted this period — reload so the
      // drawdown below sees the current balance.
      subscription = (await Subscription.findById(subscription._id)) ?? subscription;
    }
  }

  // 2. Plan the drawdown from the current balance → reduced quantities to report.
  const balance = subscription.creditBalanceCents ?? 0;
  const plan = (creditsActive && balance > 0)
    ? planMeteredDrawdown(subscription.addons ?? [], bundleToDimensionMap, dimensionPriceMap, balance)
    : null;

  if (plan?.unrealizable) {
    logger.warn('Marketplace credit cannot be realized — no priced meterable dimension', { orgId, balanceCents: balance });
    incCounter('billing_marketplace_credit_unrealizable_total', {});
  }
  if (plan && drawdownDryRun && plan.consumedCents > 0) {
    logger.info('Marketplace drawdown DRY-RUN — reporting full usage', { orgId, wouldConsumeCents: plan.consumedCents, wouldRemainCents: plan.remainingCents });
  }

  // Report withheld (reduced) quantities live; report full quantities in dry-run.
  const reportAddons = (plan && !drawdownDryRun) ? plan.adjustedAddons : (subscription.addons ?? []);

  // 3. Report to AWS.
  let result: MeterUsageResult;
  try {
    result = await provider.meterAddonUsage(customerId, reportAddons, now);
  } catch (err) {
    logger.warn('AWS Marketplace metering failed (will be retried next cycle)', { orgId, error: String(err) });
    return { status: 'error', error: String(err) };
  }

  // 4. Consume the credit — but ONLY for dimensions AWS actually accepted. A
  //    partial BatchMeterUsage means the reduced quantity was applied for the
  //    accepted records (customer under-billed → credit truly spent) but NOT for
  //    the unprocessed ones (retried next cycle). Drawing down the full plan on a
  //    partial batch would double-discount the unprocessed dimensions; drawing
  //    down nothing (the old `unprocessed === 0` gate) double-discounts the
  //    ACCEPTED ones. So attribute consumption to the accepted lines only.
  //    At most once per AWS dedupe-hour, atomic on the balance.
  const unprocessedDims = new Set(result.unprocessedDimensions ?? []);
  const acceptedLines = plan ? plan.perLine.filter((l) => !unprocessedDims.has(l.dimension)) : [];
  const acceptedConsumedCents = acceptedLines.reduce((s, l) => s + l.creditConsumedCents, 0);
  if (plan && !drawdownDryRun && acceptedConsumedCents > 0) {
    const hourKey = hourKeyFor(now);
    const drawn = await Subscription.findOneAndUpdate(
      { '_id': subscription._id, 'metadata.lastDrawdownHour': { $ne: hourKey }, 'creditBalanceCents': { $gte: acceptedConsumedCents } },
      {
        $set: { 'metadata.lastDrawdownHour': hourKey },
        $inc: { creditBalanceCents: -acceptedConsumedCents },
      },
      { new: true },
    );
    if (drawn) {
      const periodKey = billingPeriodKey(subscription.interval, now);
      const { start, end } = periodBounds(subscription.interval, now);
      await recordMarketplaceConsumption(orgId, periodKey, start, end, acceptedConsumedCents);
      const subId = subscription._id.toString();
      await createBillingEvent(orgId, 'credit_consumed', { consumedCents: acceptedConsumedCents, dimensions: acceptedLines.length, partial: unprocessedDims.size > 0 }, subId);
      // Mirror to the central audit trail (system-initiated; no request actor).
      getAuditClient().record({
        action: 'billing.credit.consumed',
        actorId: 'system',
        orgId,
        targetId: subId,
        details: { consumedCents: acceptedConsumedCents, dimensions: acceptedLines.length, subscriptionId: subId },
      }, 'billing');
      incCounter('billing_marketplace_credit_consumed_total', {});
      if ((drawn.creditBalanceCents ?? 0) === 0) {
        await createBillingEvent(orgId, 'credit_exhausted', { previousCents: balance }, subId);
        getAuditClient().record({
          action: 'billing.credit.exhausted',
          actorId: 'system',
          orgId,
          targetId: subId,
          details: { previousCents: balance, subscriptionId: subId },
        }, 'billing');
      }
    }
  }

  return { status: 'metered', result };
}

/**
 * Report add-on usage for EVERY Marketplace account with add-ons — one metering
 * cycle. Finds active Marketplace subscriptions carrying add-ons and reports each
 * to AWS. Per-account failures are isolated (logged, not thrown) so one bad
 * customer can't stall the cycle. AWS dedupes by (customer, dimension, hour), so
 * an hourly cadence re-reporting the same quantities is safe/idempotent.
 */
export async function reportAllMarketplaceAddonUsage(): Promise<{ accounts: number; metered: number; errors: number }> {
  // Only active subs that actually carry add-ons — skip the rest cheaply.
  const subs = await Subscription.find({
    'status': 'active',
    'metadata.provider': 'aws-marketplace',
    'addons': { $exists: true, $ne: [] },
  }).select('orgId').lean();

  let metered = 0;
  let errors = 0;
  for (const sub of subs) {
    // Per-account isolation: a thrown DB error (atomic claim, grant, save, drawdown)
    // must not abort the cycle and strand every remaining account.
    try {
      const outcome = await reportMarketplaceAddonUsage(sub.orgId);
      if (outcome.status === 'metered') metered += 1;
      else if (outcome.status === 'error') errors += 1;
    } catch (err) {
      errors += 1;
      logger.warn('Marketplace metering: per-account cycle failed (isolated)', { orgId: sub.orgId, error: String(err) });
    }
  }

  if (subs.length > 0) {
    logger.info('Marketplace metering cycle complete', { accounts: subs.length, metered, errors });
  }
  return { accounts: subs.length, metered, errors };
}

// Cross-pod single-runner lock. Correctness is already guaranteed by the per-hour /
// per-period atomic claims inside the cycle; the lock is an EFFICIENCY guard so N
// replicas don't all redundantly walk the account set. Absent Redis it's a no-op and
// the cycle runs on every pod (still safe). TTL comfortably exceeds one run and is
// well under the hourly cadence so the next cycle can re-acquire.
const LOCK_TTL_MS = 5 * 60 * 1000;
const lockClient = createEnvRedisLock();

// Periodic metering cycle. Wrapped in a sysadmin tenant scope to match the other
// multi-org billing crons (subscription-lifecycle). Gated at start() time so the
// timer only exists on Marketplace deployments that opted in.
const scheduler: Scheduler = createScheduler({
  name: 'marketplace-metering',
  intervalMs: config.meteringIntervalMs,
  run: async () => { await runWithTenantContext({ isSuperAdmin: true }, reportAllMarketplaceAddonUsage); },
  ...(lockClient ? { lock: { redis: () => lockClient, key: 'marketplace-metering', ttlMs: LOCK_TTL_MS } } : {}),
});

/**
 * Start the metering cycle — a no-op unless the provider is aws-marketplace AND
 * `BILLING_METERING_ENABLED=true` (so non-Marketplace deployments and un-opted
 * Marketplace ones never spin the timer). Safe to call multiple times.
 */
export function startMarketplaceMetering(): void {
  if (config.billingProvider !== 'aws-marketplace' || !config.meteringEnabled) {
    logger.debug('Marketplace metering disabled — scheduler not started', {
      provider: config.billingProvider,
      meteringEnabled: config.meteringEnabled,
    });
    return;
  }
  // Sub-hour cadence + credit drawdown is unsafe: AWS dedupes BatchMeterUsage by
  // (customer, dimension, hour), so a second reduced report in the same hour is
  // ignored by AWS while the local balance would still be drawn down (over-consume).
  // The per-hour drawdown claim already bounds it to once/hour, but warn loudly if an
  // operator sets a cadence finer than the dedupe window while credits are active.
  if (config.marketplace.creditsEnabled && config.meteringIntervalMs < 3600000) {
    logger.warn('Metering cadence is finer than AWS\'s 1-hour dedupe window while credits are active — credit drawdown may over-consume; use ≥ 1h', { intervalMs: config.meteringIntervalMs });
  }
  logger.info('Starting Marketplace add-on metering cycle', { intervalMs: config.meteringIntervalMs });
  scheduler.start();
}

/** Stop the metering cycle (graceful shutdown). Safe to call when never started. */
export function stopMarketplaceMetering(): void { scheduler.stop(); }
