// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Marketplace SNS entitlement RECONCILIATION — turning a marketplace
 * notification (subscribe / unsubscribe / entitlement-updated) into the local
 * subscription + entitlement state.
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
import {
  calculatePeriodEnd,
  createBillingEvent,
  syncEntitlements,
  recordReactivatePlanMissing,
  MANAGEABLE_SUBSCRIPTION_STATUSES,
} from './billing-helpers.js';
import { mapActionToStatus, type MarketplaceNotification } from './marketplace-helpers.js';
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
 * Process a parsed marketplace notification.
 * Handles entitlement updates, cancellations, reactivations, and other status changes.
 * @param notification - Parsed marketplace notification payload from SNS
 */
export async function processMarketplaceNotification(notification: MarketplaceNotification): Promise<void> {
  const {
    action,
    'customer-identifier': customerIdentifier,
    'product-code': productCode,
  } = notification;

  logger.info('Processing marketplace notification', { action, customerIdentifier, productCode });

  // Entitlement update — re-check entitlements and update plan
  if (action === 'entitlement-updated') {
    await handleEntitlementUpdate(customerIdentifier);
    return;
  }

  // Map action to subscription status change
  const statusChange = mapActionToStatus(action);
  if (!statusChange) {
    logger.warn('Unknown marketplace notification action', { action });
    return;
  }

  // cancel→resubscribe can leave a canceled row + a new active row sharing the
  // identifier (the unique index is partial on active rows). Take the NEWEST so
  // the notification lands on the current subscription, not a stale canceled one.
  const subscription = await Subscription.findOne({
    'metadata.awsCustomerIdentifier': customerIdentifier,
  }).sort({ createdAt: -1 });

  if (!subscription) {
    logger.warn('No subscription found for marketplace customer', { customerIdentifier });
    return;
  }

  const previousStatus = subscription.status;
  subscription.status = statusChange.status;
  subscription.cancelAtPeriodEnd = statusChange.cancelAtPeriodEnd;
  await subscription.save();

  // These billing events originate from AWS Marketplace SNS notifications, not
  // a request user — actorId is intentionally left undefined (no fabricated
  // actor for system-driven events).
  // Determine event type and sync tier.
  // For an immediate cancel ('canceled') we downgrade now. For a soft cancel
  // ('cancelAtPeriodEnd') the org has paid through `currentPeriodEnd`, so we do
  // NOT downgrade now — but note the actual downgrade then comes from a later
  // `unsubscribe-success` SNS, NOT the lifecycle cron: that cron skips
  // marketplace rows (subscription-lifecycle.ts records a stale-period event
  // only). If the terminal SNS is missed, GetEntitlements-backed reconciliation
  // would be needed to catch it.
  if (statusChange.status === 'canceled') {
    await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());
    await createBillingEvent(subscription.orgId, 'subscription_canceled', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
    }, subscription._id.toString());
  } else if (statusChange.status === 'incomplete' && (MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(previousStatus)) {
    // subscribe-fail from a previously-ENTITLED state: `incomplete` is not an
    // entitled status, so downgrade rather than leave the paid tier in place.
    await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());
    await createBillingEvent(subscription.orgId, 'subscription_updated', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      reason: 'subscribe_fail_downgrade',
      customerIdentifier,
    }, subscription._id.toString());
  } else if (statusChange.cancelAtPeriodEnd) {
    await createBillingEvent(subscription.orgId, 'subscription_canceled', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
      pendingDowngradeAt: subscription.currentPeriodEnd,
    }, subscription._id.toString());
  } else if (previousStatus === 'canceled' && statusChange.status === 'active') {
    const plan = await Plan.findById(subscription.planId);
    if (plan) {
      await syncEntitlements(subscription.orgId, plan.tier, '', subscription._id.toString(), subscription.addons ?? []);
    } else {
      // planId points at a deleted/missing plan: the sub reactivates into an
      // entitled status but we can't resolve a tier to re-grant — the sync
      // silently no-ops. Surface it (WARN + audit row + metric) so support can
      // repair the dangling planId. The subscription_reactivated row below still
      // records the reactivation; this adds the plan-missing signal.
      logger.warn('Marketplace reactivation could not sync — subscription plan not found', {
        orgId: subscription.orgId, customerIdentifier, planId: subscription.planId,
      });
      await recordReactivatePlanMissing(subscription.orgId, subscription._id.toString(), 'marketplace', {
        provider: 'aws-marketplace', planId: subscription.planId,
      });
    }
    await createBillingEvent(subscription.orgId, 'subscription_reactivated', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
    }, subscription._id.toString());
  } else {
    await createBillingEvent(subscription.orgId, 'subscription_updated', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
    }, subscription._id.toString());
  }

  logger.info('Marketplace notification processed', {
    action,
    customerIdentifier,
    orgId: subscription.orgId,
    previousStatus,
    newStatus: statusChange.status,
  });
}

/**
 * Handle an entitlement-updated notification.
 * Re-checks entitlements via the Marketplace API and upgrades/downgrades the plan.
 * @param customerIdentifier - AWS Marketplace customer identifier
 */
export async function handleEntitlementUpdate(customerIdentifier: string): Promise<void> {
  const provider = getMarketplaceProvider();
  if (!provider) return;

  const subscription = await Subscription.findOne({
    'metadata.awsCustomerIdentifier': customerIdentifier,
    'status': 'active',
  });

  if (!subscription) {
    logger.warn('No active subscription for entitlement update', { customerIdentifier });
    return;
  }

  const entitlements = await provider.getEntitlements(customerIdentifier);
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
        customerIdentifier, orgId: subscription.orgId, currentPeriodEnd: exp.toISOString(),
      });
      return;
    }
    logger.debug('Entitlement unchanged', { customerIdentifier, planId: newPlanId, interval: newInterval });
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
      provider: 'aws-marketplace', customerIdentifier, oldInterval, newInterval,
    }, subscription._id.toString());
    logger.info('Marketplace interval re-cadenced from entitlement change', {
      customerIdentifier, orgId: subscription.orgId, oldInterval, newInterval,
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
  // (which mints its own service token — no user context on the SNS path). System
  // path → no actorId. Marketplace add-ons are AWS-metered, so the provider
  // line-item removal inside finalizePrunedAddons is a no-op (local event + audit
  // still recorded so finance can reconcile).
  const runSideEffects = applyPlanTierChange(subscription, plan, {
    oldPlanId,
    newPlanId,
    pruned,
    authHeader: '',
    source: 'marketplace_plan_change',
    eventDetails: { provider: 'aws-marketplace', customerIdentifier, dimension: activeEntitlement?.dimension, interval: subscription.interval },
  });

  await subscription.save();
  await runSideEffects();

  // A plan change that ALSO moved the cadence records a distinct interval_changed
  // row (the plan_changed row above only carries the interval as a detail) so the
  // move is visible in the billing timeline.
  if (intervalChanged) {
    await createBillingEvent(subscription.orgId, 'interval_changed', {
      provider: 'aws-marketplace', customerIdentifier, oldInterval, newInterval,
    }, subscriptionId);
  }

  logger.info('Plan updated from entitlement change', {
    customerIdentifier,
    oldPlanId,
    newPlanId,
    orgId: subscription.orgId,
    interval: subscription.interval,
    intervalChanged,
  });
}

// Route factory
