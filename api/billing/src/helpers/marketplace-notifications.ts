// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Marketplace entitlement RECONCILIATION — turning a marketplace license
 * event (License Updated / License Deprovisioned) into the local subscription +
 * entitlement state.
 *
 * AWS delivers these as EventBridge events (`source: aws.agreement-marketplace`)
 * on the seller account's default bus. The deploy's EventBridge rule forwards
 * them to a platform-owned SNS topic, which reaches the signature-verified
 * `POST /marketplace/sns` endpoint. Agreement events are not handled: each one is
 * followed by a License event for the same purchase, and only License events name
 * the license billing keys customers on.
 *
 * Extracted from `routes/marketplace.ts`, where ~300 lines of reconciliation sat
 * ABOVE the router, so the route module was mostly not routes. Same split as
 * `helpers/stripe-reversals.ts`: the route file keeps signature verification,
 * dedupe and dispatch; the business logic lives beside the other billing helpers
 * (`marketplace-helpers.ts` was already next door).
 */

import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { applyPlanTierChange, applyTierIncludedAddonPrune } from './addon-prune.js';
import { calculatePeriodEnd, createBillingEvent } from './billing-helpers.js';
import { syncEntitlements } from './entitlement-sync.js';
import { licenseIdOf, type MarketplaceEvent } from './marketplace-license.js';
import { config } from '../config.js';
import { Plan } from '../models/plan.js';
import { Subscription, type BillingInterval } from '../models/subscription.js';
import { AWSMarketplaceProvider, type EntitlementResult } from '../providers/aws-marketplace-provider.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('billing-marketplace-notifications');

/**
 * A resolved entitlement whose remaining term exceeds this horizon is treated as
 * an ANNUAL contract, otherwise monthly. At resolve time (immediately after the
 * customer subscribes) the entitlement's remaining term ≈ the full contract
 * term, so an annual offer's expiration is ~1 year out and a monthly offer's is
 * ~1 month out — well separated by a ~6-month threshold.
 */
const ANNUAL_TERM_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Derive the billing interval for a marketplace subscription from the resolved
 * entitlement. AWS Marketplace SaaS does NOT expose a first-class billing-cadence
 * field in ResolveCustomer / GetEntitlements, so we infer it from the
 * entitlement's `ExpirationDate` horizon (see {@link ANNUAL_TERM_THRESHOLD_MS}):
 * a term more than ~6 months out is annual, otherwise monthly. When the
 * entitlement carries no expiration we can't tell — default to `'monthly'`.
 *
 * TODO(marketplace): if the product listing later exposes a dedicated
 * billing-term dimension (or ResolveCustomer surfaces the offer cadence), map
 * that authoritative value here instead of inferring from the expiration horizon.
 */
export function deriveMarketplaceInterval(entitlement: EntitlementResult | undefined, now: Date): BillingInterval {
  const exp = entitlement?.expirationDate;
  if (!exp) {
    // No expiration to key on ⇒ low-confidence default. Meter it: a high rate
    // means the listing should expose an authoritative billing-term dimension
    // rather than us inferring cadence from the expiration horizon.
    incCounter('billing_marketplace_interval_inference_low_confidence_total', {});
    return 'monthly';
  }
  return exp.getTime() - now.getTime() > ANNUAL_TERM_THRESHOLD_MS ? 'annual' : 'monthly';
}

/**
 * The period end a Marketplace subscription should carry: the entitlement's own
 * `expirationDate` (AWS's authoritative term end) when it lies after `start`,
 * else the cadence-derived fallback. A wall-clock period drifts from the real
 * term and made still-entitled subs look expired to the stale-period scan.
 */
export function marketplacePeriodEnd(
  exp: Date | undefined,
  start: Date,
  interval: BillingInterval,
): Date {
  return exp instanceof Date && exp > start ? exp : calculatePeriodEnd(start, interval);
}

// Helpers

/**
 * Return the active payment provider if it is an AWS Marketplace provider.
 * @returns The marketplace provider instance, or null if a different provider is active
 */
export function getMarketplaceProvider(): AWSMarketplaceProvider | null {
  const provider = getPaymentProvider();
  return provider instanceof AWSMarketplaceProvider ? provider : null;
}

/**
 * License Deprovisioned: the buyer's entitlement has ended (cancelled, expired or
 * terminated). Cancel the subscription and downgrade the org to the free tier.
 *
 * The event opens AWS's one-hour final-usage window. The hourly metering cycle
 * reports active subscriptions only, so usage in that last partial hour is not
 * reported.
 */
export async function handleLicenseDeprovisioned(licenseArn: string): Promise<void> {
  const licenseId = licenseIdOf(licenseArn);
  // Take the NEWEST row for the license, so a stale canceled row never wins.
  const subscription = await Subscription.findOne({
    'metadata.awsLicenseArn': licenseArn,
  }).sort({ createdAt: -1 });

  if (!subscription) {
    logger.warn('No subscription found for deprovisioned marketplace license', { licenseId });
    return;
  }
  if (subscription.status === 'canceled') {
    logger.info('Marketplace license already canceled', { licenseId, orgId: subscription.orgId });
    return;
  }

  const previousStatus = subscription.status;
  subscription.status = 'canceled';
  subscription.cancelAtPeriodEnd = false;
  await subscription.save();

  // System-driven (AWS event, no request user): actorId is left undefined.
  await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());
  await createBillingEvent(subscription.orgId, 'subscription_canceled', {
    provider: 'aws-marketplace',
    reason: 'license_deprovisioned',
    previousStatus,
    newStatus: 'canceled',
    licenseId,
  }, subscription._id.toString());

  logger.info('Marketplace subscription canceled (license deprovisioned)', {
    licenseId, orgId: subscription.orgId, previousStatus,
  });
}

/**
 * License Updated: the buyer's entitlement changed. Re-checks the license's
 * entitlements via the Marketplace API and upgrades/downgrades the plan.
 * @param licenseArn - The customer's license (as stored at registration)
 */
export async function handleEntitlementUpdate(licenseArn: string): Promise<void> {
  const provider = getMarketplaceProvider();
  if (!provider) return;
  const licenseId = licenseIdOf(licenseArn);

  const subscription = await Subscription.findOne({
    'metadata.awsLicenseArn': licenseArn,
    'status': 'active',
  });

  if (!subscription) {
    logger.warn('No active subscription for entitlement update', { licenseId });
    return;
  }

  const entitlements = await provider.getEntitlements(licenseArn);
  const activeEntitlement = entitlements.find((e) => e.isEntitled);
  const newPlanId = activeEntitlement?.planId || 'developer';

  // Re-derive the billing cadence from the (possibly new) entitlement term. AWS
  // does not surface cadence directly, so a monthly↔annual MOVE only shows up as a
  // changed ExpirationDate horizon (see deriveMarketplaceInterval). Without this
  // the interval stays stale after such a move and every downstream period key
  // (periodKeyFor / periodBounds) + interval-priced credit (priceForInterval)
  // mis-keys against the old cadence.
  //
  // BUT the horizon SHRINKS as a term ages: an annual sub sitting in the back half
  // of its term has `exp - now < 180d`, so deriveMarketplaceInterval would read
  // 'monthly' and — on this UPDATE path — flip the sub to monthly, reset the period,
  // and mis-price credits purely because time passed. AWS exposes no authoritative
  // cadence field to disambiguate, so we only ADOPT a horizon-derived interval when
  // it LENGTHENS the term (monthly→annual). An existing annual interval is never
  // shortened from the horizon alone; a genuine annual→monthly downgrade arrives as
  // a plan/dimension change and re-cadences through the plan-change path below.
  const now = new Date();
  const derivedInterval = deriveMarketplaceInterval(activeEntitlement, now);
  const newInterval: BillingInterval =
    subscription.interval === 'monthly' && derivedInterval === 'annual'
      ? 'annual'
      : subscription.interval;
  const intervalChanged = newInterval !== subscription.interval;

  // Nothing to do only when BOTH the plan AND the cadence are unchanged — an
  // interval-only move (same plan, monthly→annual) must still re-cadence.
  if (newPlanId === subscription.planId && !intervalChanged) {
    // Same plan + cadence, but a renewal moves the entitlement's expiry forward:
    // adopt it so the local period tracks AWS (otherwise the stale-period scan
    // flags a paid, still-entitled sub every tick after the old end passes).
    const exp = activeEntitlement?.expirationDate;
    if (exp instanceof Date && exp > subscription.currentPeriodEnd) {
      subscription.currentPeriodStart = subscription.currentPeriodEnd;
      subscription.currentPeriodEnd = exp;
      await subscription.save();
      logger.info('Marketplace period advanced from entitlement expiry', {
        licenseId, orgId: subscription.orgId, currentPeriodEnd: exp.toISOString(),
      });
      return;
    }
    logger.debug('Entitlement unchanged', { licenseId, planId: newPlanId, interval: newInterval });
    return;
  }

  // An interval-only move (same plan) still needs the period re-cadenced +
  // interval_changed recorded, but there is no tier/entitlement change to sync.
  if (newPlanId === subscription.planId && intervalChanged) {
    const oldInterval = subscription.interval;
    subscription.interval = newInterval;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = marketplacePeriodEnd(activeEntitlement?.expirationDate, now, newInterval);
    await subscription.save();
    await createBillingEvent(subscription.orgId, 'interval_changed', {
      provider: 'aws-marketplace', licenseId, oldInterval, newInterval,
    }, subscription._id.toString());
    logger.info('Marketplace interval re-cadenced from entitlement change', {
      licenseId, orgId: subscription.orgId, oldInterval, newInterval,
    });
    return;
  }

  const plan = await Plan.findOne({ _id: newPlanId, isActive: true });
  if (!plan) {
    logger.error('Entitlement maps to unknown plan', { newPlanId });
    return;
  }

  const oldPlanId = subscription.planId;
  const oldInterval = subscription.interval;
  subscription.planId = newPlanId;
  // Re-cadence alongside the plan change so credit-period math tracks the current
  // term — mirrors the resolve path (which sets interval + period from the same
  // entitlement). A no-op when the cadence is unchanged.
  if (intervalChanged) {
    subscription.interval = newInterval;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = marketplacePeriodEnd(activeEntitlement?.expirationDate, now, newInterval);
  }

  // Prune any PURE-FEATURE add-on the new tier now bundles in (double-billing
  // fix) so a marketplace tier upgrade also drops the redundant paid bundle.
  // Mutates the doc's addons in memory (persisted by save below); hybrid bundles
  // that also grant a quota are kept.
  const subscriptionId = subscription._id.toString();
  const pruned = applyTierIncludedAddonPrune(subscription, plan.tier, {
    orgId: subscription.orgId, subscriptionId, source: 'marketplace_plan_change',
  });

  // Shared post-save runner: entitlement sync (preserving add-ons) → plan_changed
  // row → addon_pruned trail. `authHeader: ''` threads through to syncEntitlements
  // (which mints its own service token — no user context on an AWS event). System
  // path → no actorId. Marketplace add-ons are AWS-metered, so the provider
  // line-item removal inside finalizePrunedAddons is a no-op (local event + audit
  // still recorded so finance can reconcile).
  const runSideEffects = applyPlanTierChange(subscription, plan, {
    oldPlanId,
    newPlanId,
    pruned,
    authHeader: '',
    source: 'marketplace_plan_change',
    eventDetails: { provider: 'aws-marketplace', licenseId, dimension: activeEntitlement?.dimension, interval: subscription.interval },
  });

  await subscription.save();
  await runSideEffects();

  // A plan change that ALSO moved the cadence records a distinct interval_changed
  // row (the plan_changed row above only carries the interval as a detail) so the
  // move is visible in the billing timeline.
  if (intervalChanged) {
    await createBillingEvent(subscription.orgId, 'interval_changed', {
      provider: 'aws-marketplace', licenseId, oldInterval, newInterval,
    }, subscriptionId);
  }

  logger.info('Plan updated from entitlement change', {
    licenseId,
    oldPlanId,
    newPlanId,
    orgId: subscription.orgId,
    interval: subscription.interval,
    intervalChanged,
  });
}

/**
 * Process an AWS Marketplace EventBridge event (delivered through SNS).
 * @param event - The EventBridge event from the SNS Message body
 */
export async function processMarketplaceEvent(event: MarketplaceEvent): Promise<void> {
  const detailType = event['detail-type'];
  const handler = detailType === 'License Updated - Manufacturer' ? handleEntitlementUpdate
    : detailType === 'License Deprovisioned - Manufacturer' ? handleLicenseDeprovisioned
      : undefined;
  if (!handler) {
    logger.info('Marketplace event needs no action', { detailType });
    return;
  }

  const productCode = event.detail?.product?.code;
  const licenseId = licenseIdOf(event.detail?.license?.arn ?? '');
  if (!licenseId) {
    logger.warn('Marketplace event carries no license ARN — ignoring', { detailType });
    return;
  }

  // Belt and braces behind the EventBridge rule, which already filters on the
  // product code: a rule whose pattern drifted from AWS_MARKETPLACE_PRODUCT_CODE
  // would otherwise hand a sibling product's events write access to these
  // subscriptions. Drop rather than throw: the event is not ours, and failing the
  // request would make SNS retry something that can never succeed.
  if (productCode !== config.marketplace.productCode) {
    incCounter('billing_marketplace_product_code_mismatch_total', { source: 'eventbridge' });
    logger.warn('Marketplace event is for a different product — ignoring', { detailType, productCode });
    return;
  }

  const licenseArn = await storedLicenseArn(licenseId);
  if (!licenseArn) {
    // A License Updated event also fires at purchase, before the buyer has
    // registered; registration reads the entitlement itself, so nothing is lost.
    logger.info('No subscription for marketplace license yet', { detailType, licenseId });
    return;
  }

  logger.info('Processing marketplace license event', { detailType, licenseId });
  await handler(licenseArn);
}

/**
 * The stored license ARN for a license id. Matched on the `l-…` id, not the
 * whole ARN, because AWS does not write the ARN prefix the same way in
 * ResolveCustomer and in events. `licenseId` is `[0-9a-z-]` only (licenseIdOf),
 * so it is safe inside the pattern.
 */
async function storedLicenseArn(licenseId: string): Promise<string | undefined> {
  const subscription = await Subscription.findOne({
    'metadata.awsLicenseArn': { $regex: `[:/]${licenseId}$`, $options: 'i' },
  }).sort({ createdAt: -1 });
  return subscription?.metadata?.awsLicenseArn as string | undefined;
}
