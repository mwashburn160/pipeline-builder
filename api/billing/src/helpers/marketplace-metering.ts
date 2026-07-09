// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createScheduler, type Scheduler } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-core';
import { config } from '../config.js';
import { Subscription } from '../models/subscription.js';
import { AWSMarketplaceProvider, type MeterUsageResult } from '../providers/aws-marketplace-provider.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('marketplace-metering');

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
 * Intended to be driven on a CADENCE (a periodic usage job or an entitlement
 * webhook) — NOT synchronously on an add-on mutation, since Marketplace add-ons
 * are not self-service in-app. Wiring that trigger is the remaining integration
 * step; this helper is the unit it calls.
 *
 * @param orgId The account (root) org whose add-on usage to report.
 */
export async function reportMarketplaceAddonUsage(orgId: string): Promise<MeteringOutcome> {
  if (config.billingProvider !== 'aws-marketplace') {
    return { status: 'skipped', reason: 'not-marketplace' };
  }

  const subscription = await Subscription.findOne({ orgId, status: 'active' });
  if (!subscription) return { status: 'skipped', reason: 'no-subscription' };

  const customerId = (subscription.metadata?.awsCustomerIdentifier as string | undefined)
    ?? subscription.externalCustomerId
    ?? undefined;
  if (!customerId) return { status: 'skipped', reason: 'no-customer' };

  const addons = subscription.addons ?? [];
  if (addons.length === 0) return { status: 'skipped', reason: 'no-addons' };

  const provider = getPaymentProvider();
  if (!(provider instanceof AWSMarketplaceProvider)) {
    // Provider config and billingProvider disagree — don't guess.
    return { status: 'skipped', reason: 'provider-mismatch' };
  }

  try {
    const result = await provider.meterAddonUsage(customerId, addons);
    return { status: 'metered', result };
  } catch (err) {
    logger.warn('AWS Marketplace metering failed (will be retried next cycle)', { orgId, error: String(err) });
    return { status: 'error', error: String(err) };
  }
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
    const outcome = await reportMarketplaceAddonUsage(sub.orgId);
    if (outcome.status === 'metered') metered += 1;
    else if (outcome.status === 'error') errors += 1;
  }

  if (subs.length > 0) {
    logger.info('Marketplace metering cycle complete', { accounts: subs.length, metered, errors });
  }
  return { accounts: subs.length, metered, errors };
}

// Periodic metering cycle. Wrapped in a sysadmin tenant scope to match the other
// multi-org billing crons (subscription-lifecycle). Gated at start() time so the
// timer only exists on Marketplace deployments that opted in.
const scheduler: Scheduler = createScheduler({
  name: 'marketplace-metering',
  intervalMs: config.meteringIntervalMs,
  run: async () => { await runWithTenantContext({ isSuperAdmin: true }, reportAllMarketplaceAddonUsage); },
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
  logger.info('Starting Marketplace add-on metering cycle', { intervalMs: config.meteringIntervalMs });
  scheduler.start();
}

/** Stop the metering cycle (graceful shutdown). Safe to call when never started. */
export function stopMarketplaceMetering(): void { scheduler.stop(); }
