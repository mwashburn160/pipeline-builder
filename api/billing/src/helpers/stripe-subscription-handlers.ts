// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stripe `customer.subscription.*` webhook handlers (created / updated / deleted).
 * Dispatched by routes/stripe-webhook.ts after signature verification + the
 * two-phase idempotency claim.
 *
 * NOTE: every createBillingEvent here runs from Stripe's webhook (no request user),
 * so actorId is intentionally left undefined — we never fabricate an actor for
 * provider-driven events.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type Stripe from 'stripe';
import { applyPlanTierChange, applyTierIncludedAddonPrune } from './addon-prune.js';
import { billingServiceAuth, createBillingEvent, calculatePeriodEnd, syncEntitlements, recordReactivatePlanMissing, MANAGEABLE_SUBSCRIPTION_STATUSES } from './billing-helpers.js';
import type { PrunedAddon } from './billing-helpers.js';
import { clearDiscountsOnCancel } from './discount-helpers.js';
import { runSignupPromotions } from './signup-promotions.js';
import { findSubscriptionByStripeId, mapStripeStatus } from './stripe-helpers.js';
import { config } from '../config.js';
import { Plan, type PlanDocument } from '../models/plan.js';
import { Subscription, type SubscriptionDocument, type BillingInterval } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('billing-stripe-webhook');

/**
 * Reverse the configured `{planId}_{interval}` → Stripe-price-id map to recover
 * the plan + interval a Stripe price belongs to. Used to detect a plan change
 * made directly in Stripe (dashboard/API) from a `customer.subscription.updated`
 * webhook. Returns null for an unknown price (e.g. a bundle price — bundles are
 * reconciled separately) or a malformed map key.
 */
export function planFromStripePrice(priceId: string): { planId: string; interval: 'monthly' | 'annual' } | null {
  for (const [key, id] of Object.entries(config.stripe?.priceToPlanMap ?? {})) {
    if (id !== priceId) continue;
    const idx = key.lastIndexOf('_');
    if (idx <= 0) continue;
    const planId = key.slice(0, idx);
    const interval = key.slice(idx + 1);
    if (interval === 'monthly' || interval === 'annual') return { planId, interval };
  }
  return null;
}

/**
 * Handle a subscription created by Stripe — the self-serve **Checkout** flow
 * (`POST /subscriptions/checkout` → hosted Checkout → this event) or an
 * out-of-band create (Stripe dashboard / API). Without this the local DB drifts
 * from Stripe and the org has no Subscription row backing the Stripe customer.
 *
 * - Already have a row for this Stripe subscription ID → treat as an update
 *   (in-app create + webhook race, or a redelivered event).
 * - Metadata carries `orgId` + `planId` (Checkout stamps them via
 *   `subscription_data.metadata`) → **provision** the local row + grant
 *   entitlements. This is what makes Stripe self-serve actually reach an active,
 *   entitled subscription.
 * - `orgId` but no `planId` (a bare dashboard create) → can't resolve the plan;
 *   log + meter for operator follow-up. No `orgId` → unbound; meter + event.
 */
export async function handleSubscriptionCreated(stripeSubscription: Stripe.Subscription): Promise<void> {
  const externalId = stripeSubscription.id;
  const existing = await findSubscriptionByStripeId(externalId);
  if (existing) {
    return handleSubscriptionUpdated(stripeSubscription);
  }
  const orgId = (stripeSubscription.metadata?.orgId || '').trim();
  if (!orgId) {
    logger.warn('Stripe subscription created without orgId metadata — cannot auto-provision', { externalId });
    // Alertable: a Stripe sub exists that backs no org. Without a metric this is
    // a silently-swallowed billing_events row no one watches.
    incCounter('billing_unbound_stripe_subscription_total', { reason: 'no_org_metadata' });
    await createBillingEvent('unknown', 'subscription_created', { unbound: true, externalId });
    return;
  }
  const planId = (stripeSubscription.metadata?.planId || '').trim();
  if (!planId) {
    // A bare out-of-band create (no plan metadata) — we can't resolve the tier.
    logger.warn('Stripe subscription created out-of-band — operator action required', { externalId, orgId });
    incCounter('billing_unbound_stripe_subscription_total', { reason: 'out_of_band' });
    await createBillingEvent(orgId, 'subscription_created', { unbound: true, externalId });
    return;
  }

  // Checkout completion → provision the local subscription + entitlements.
  const plan = await Plan.findOne({ _id: planId, isActive: true });
  if (!plan) {
    logger.warn('Stripe subscription references an unknown/inactive plan', { externalId, orgId, planId });
    incCounter('billing_unbound_stripe_subscription_total', { reason: 'unknown_plan' });
    await createBillingEvent(orgId, 'subscription_created', { unbound: true, externalId, planId });
    return;
  }

  // Duplicate guard: the org already has a manageable subscription bound to a
  // DIFFERENT Stripe sub (two checkouts completed, or checkout raced an in-app
  // create). Cancel this incoming duplicate IMMEDIATELY so the customer isn't
  // double-billed — the existing row is the keeper — and alert.
  const existingForOrg = await Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } });
  if (existingForOrg && existingForOrg.externalId !== externalId) {
    await cancelDuplicateStripeSub(externalId, orgId);
    return;
  }

  const interval = (stripeSubscription.metadata?.interval === 'annual' ? 'annual' : 'monthly') as BillingInterval;
  const customerId = typeof stripeSubscription.customer === 'string' ? stripeSubscription.customer : stripeSubscription.customer?.id;
  const status = mapStripeStatus(stripeSubscription.status);
  // Prefer Stripe's real period (matters for trials / annual) when the SDK surfaces
  // it; else wall-clock (corrected on the first invoice.payment_succeeded anyway).
  const stripePeriod = stripeSubscription as unknown as { current_period_start?: number; current_period_end?: number };
  const periodStart = stripePeriod.current_period_start ? new Date(stripePeriod.current_period_start * 1000) : new Date();
  const periodEnd = stripePeriod.current_period_end
    ? new Date(stripePeriod.current_period_end * 1000)
    : calculatePeriodEnd(periodStart, interval);

  let subscription: SubscriptionDocument;
  try {
    subscription = await Subscription.create({
      orgId,
      planId,
      status,
      interval,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
      externalId,
      externalCustomerId: customerId,
      metadata: { provider: 'stripe' },
    });
  } catch (err) {
    // Lost the per-org manageable-subscription uniqueness race — a concurrent
    // provision won. This incoming Stripe sub is the DUPLICATE → cancel it (don't
    // delegate to update, which would find no row for THIS externalId and no-op,
    // orphaning a billing sub). The index now covers active/trialing/past_due, so
    // this fires for a `trialing` collision too, not just `active`.
    if ((err as { code?: number }).code === 11000) {
      await cancelDuplicateStripeSub(externalId, orgId);
      return;
    }
    throw err;
  }

  // Grant the paid tier only for an entitlement-worthy status (Checkout lands
  // `active`; a card-decline would land `incomplete` and stay unprovisioned until
  // a later `.updated`→active). Mirrors the in-app create's gating.
  if (status === 'active' || status === 'trialing') {
    await syncEntitlements(orgId, plan.tier, billingServiceAuth(orgId), subscription._id.toString());
    // Promotions + referral signup — the SAME helper as the in-app create path, so
    // a Checkout signup with a referral/promo code still earns its credit. Fail-soft.
    await runSignupPromotions(subscription, plan, {
      source: 'stripe_checkout', referralCode: stripeSubscription.metadata?.referralCode,
    });
  }
  await createBillingEvent(orgId, 'subscription_created', { planId, interval, tier: plan.tier, via: 'checkout' }, subscription._id.toString());
  logger.info('Provisioned Stripe subscription from checkout', { orgId, externalId, planId, status });
}

/** Cancel a DUPLICATE Stripe subscription immediately (best-effort) + alert, so a
 *  concurrent second checkout can't double-bill the org. */
async function cancelDuplicateStripeSub(externalId: string, orgId: string): Promise<void> {
  logger.error('Duplicate Stripe subscription for org — canceling to prevent double-billing', { orgId, externalId });
  incCounter('billing_duplicate_stripe_subscription_total', { reason: 'concurrent_checkout' });
  const provider = getPaymentProvider();
  if (provider.cancelSubscriptionNow) {
    await provider.cancelSubscriptionNow(externalId).catch((e) => logger.error('Failed to cancel duplicate Stripe sub — operator refund may be needed', { externalId, err: (e as Error).message }));
  }
  await createBillingEvent(orgId, 'subscription_updated', { duplicate: true, canceledExternalId: externalId, reason: 'duplicate_checkout' });
}

/**
 * Handle subscription updates from Stripe.
 * Syncs status + cancellation state AND plan/interval changes made directly in
 * Stripe (dashboard/API) — the latter recovered by reversing the price map and
 * re-syncing tier entitlements (preserving purchased add-ons).
 */
export async function handleSubscriptionUpdated(stripeSubscription: Stripe.Subscription): Promise<void> {
  const externalId = stripeSubscription.id;
  const subscription = await findSubscriptionByStripeId(externalId);

  if (!subscription) {
    logger.warn('No subscription found for Stripe subscription', { externalId });
    return;
  }

  const previousStatus = subscription.status;
  const newStatus = mapStripeStatus(stripeSubscription.status);
  const cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end ?? false;

  // A `.updated` that crosses OUT of an entitled status into a terminal one
  // (e.g. dunning exhausted → `unpaid`→canceled, or a `.updated`→canceled whose
  // trailing `.deleted` never arrives) must downgrade — otherwise the org keeps
  // its paid tier/seats forever (no lifecycle cron catches a `canceled` row).
  const MANAGEABLE = MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[];
  const becameUnentitled = MANAGEABLE.includes(previousStatus) && !MANAGEABLE.includes(newStatus);
  // The reverse crossing: a sub created `incomplete` (card decline / 3DS / in-app
  // create with no card) whose first payment settles moves to active/trialing via
  // THIS event. The create paths deliberately withheld the tier + signup credit
  // until then, so grant them here — otherwise the paying org stays on developer.
  const becameEntitled = !MANAGEABLE.includes(previousStatus) && (newStatus === 'active' || newStatus === 'trialing');

  let dirty = false;
  if (newStatus !== subscription.status) {
    subscription.status = newStatus;
    dirty = true;
  }
  if (cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd) {
    subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;
    dirty = true;
  }
  const statusChanged = dirty;

  // Start the grace clock if Stripe moved us into past_due WITHOUT a preceding
  // invoice.payment_failed (which is what normally stamps firstFailedAt).
  // The lifecycle grace cron matches on `firstFailedAt: {$lte: cutoff}`, so a
  // null firstFailedAt would leave the sub stuck in past_due forever and never
  // get downgraded. Stamp `now` here so the clock actually starts. Leave an
  // already-set firstFailedAt untouched (don't reset an in-progress grace
  // window). Not counted in `statusChanged` — this is a clock start, not a
  // customer-visible status transition — but it still marks the row dirty so
  // the stamp persists.
  if (newStatus === 'past_due' && !subscription.firstFailedAt) {
    subscription.firstFailedAt = new Date();
    dirty = true;
  }

  // Plan/interval change made directly in Stripe: the base line item (item[0])
  // carries the plan price; reverse it to the local planId/interval and, if it
  // moved, update the record + re-sync the tier's entitlements (with add-ons).
  const basePriceId = stripeSubscription.items?.data?.[0]?.price?.id;
  const mapped = basePriceId ? planFromStripePrice(basePriceId) : null;
  const oldPlanId = subscription.planId;
  const oldInterval = subscription.interval;
  let syncedPlan: PlanDocument | null = null;
  // Whether the PLAN (tier) actually changed vs. ONLY the billing interval — an
  // interval-only edit records interval_changed, not a plan_changed w/ equal ids.
  let planChanged = false;
  // Bundles dropped because the new tier now includes their feature; their
  // provider line-item removal + audit run AFTER save (via applyPlanTierChange).
  let prunedAddons: PrunedAddon[] = [];
  if (mapped && (mapped.planId !== subscription.planId || mapped.interval !== subscription.interval)) {
    const plan = await Plan.findOne({ _id: mapped.planId, isActive: true });
    if (plan) {
      planChanged = mapped.planId !== oldPlanId;
      subscription.planId = mapped.planId;
      subscription.interval = mapped.interval;
      syncedPlan = plan;
      dirty = true;

      // Prune any PURE-FEATURE add-on the new tier now bundles in (double-billing
      // fix) so a plan change made directly in Stripe also drops the redundant
      // paid bundle. Mutates addons in memory (persisted by the `dirty` save
      // below); hybrid bundles (feature AND quota) are kept.
      prunedAddons = applyTierIncludedAddonPrune(subscription, plan.tier, {
        orgId: subscription.orgId, subscriptionId: subscription._id.toString(), source: 'stripe_plan_change',
      });
    } else {
      logger.warn('Stripe price mapped to an unknown/inactive plan; tier not synced', {
        externalId, mappedPlanId: mapped.planId,
      });
    }
  }

  // Terminal transition: forfeit the local credit mirror before the save (the
  // entitlement downgrade runs post-save below, mirroring handleSubscriptionDeleted).
  if (becameUnentitled) {
    clearDiscountsOnCancel(subscription);
    dirty = true;
  }

  // A referral code stashed by the in-app create while the sub was still
  // `incomplete` (Checkout carries it in the Stripe metadata instead). Consumed on
  // the entitling transition so it can't be replayed by a later crossing.
  const pendingReferralCode = subscription.metadata?.pendingReferralCode as string | undefined;
  if (becameEntitled && pendingReferralCode) {
    const { pendingReferralCode: _consumed, ...rest } = subscription.metadata ?? {};
    subscription.metadata = rest;
    dirty = true;
  }

  if (dirty) await subscription.save();

  if (becameUnentitled) {
    await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());
    logger.info('Stripe subscription moved to a terminal status via update — org downgraded', {
      orgId: subscription.orgId, externalId, previousStatus, newStatus,
    });
  } else if (syncedPlan) {
    // Shared post-save runner (service-token sync preserving add-ons → change
    // event → pruned line-item removal + addon_pruned trail). System path
    // (webhook) → no actorId. When ONLY the billing interval changed (same plan
    // /tier), record interval_changed instead of a plan_changed with equal ids.
    const runSideEffects = applyPlanTierChange(subscription, syncedPlan, {
      oldPlanId,
      newPlanId: subscription.planId,
      pruned: prunedAddons,
      source: 'stripe_plan_change',
      eventDetails: { provider: 'stripe', source: 'stripe_webhook', interval: subscription.interval },
      event: planChanged ? undefined : {
        type: 'interval_changed',
        details: { provider: 'stripe', source: 'stripe_webhook', oldInterval, newInterval: subscription.interval },
      },
    });
    await runSideEffects();
    logger.info('Stripe subscription plan synced', {
      orgId: subscription.orgId, externalId, oldPlanId, newPlanId: subscription.planId, interval: subscription.interval,
    });
  }

  if (becameEntitled) {
    await grantOnBecomingEntitled(subscription, syncedPlan, {
      previousStatus,
      referralCode: stripeSubscription.metadata?.referralCode || pendingReferralCode,
    });
  }

  if (statusChanged) {
    await createBillingEvent(subscription.orgId, 'subscription_updated', {
      provider: 'stripe',
      previousStatus,
      newStatus,
      cancelAtPeriodEnd,
      externalId,
    }, subscription._id.toString());

    logger.info('Stripe subscription status synced', {
      orgId: subscription.orgId,
      externalId,
      previousStatus,
      newStatus,
      cancelAtPeriodEnd,
    });
  }
}

/**
 * Post-save side effects of an unentitled → active/trialing `.updated` crossing:
 * sync the plan tier + purchased add-ons (unless a same-event plan change already
 * synced them via applyPlanTierChange) and, for a FIRST settle out of `incomplete`,
 * run the signup promotions/referral the create path withheld. A dangling planId
 * is surfaced (WARN + audit row + metric) instead of silently granting nothing.
 */
async function grantOnBecomingEntitled(
  subscription: SubscriptionDocument,
  alreadySyncedPlan: PlanDocument | null,
  opts: { previousStatus: string; referralCode?: string },
): Promise<void> {
  const subscriptionId = subscription._id.toString();
  const plan = alreadySyncedPlan ?? await Plan.findById(subscription.planId);
  if (!plan) {
    logger.warn('Stripe subscription became entitled but its plan was not found — tier not granted', {
      orgId: subscription.orgId, subscriptionId, planId: subscription.planId,
    });
    await recordReactivatePlanMissing(subscription.orgId, subscriptionId, 'stripe_webhook', {
      provider: 'stripe', planId: subscription.planId, previousStatus: opts.previousStatus,
    });
    return;
  }
  if (!alreadySyncedPlan) {
    await syncEntitlements(subscription.orgId, plan.tier, billingServiceAuth(subscription.orgId), subscriptionId, subscription.addons ?? []);
  }
  if (opts.previousStatus === 'incomplete') {
    await runSignupPromotions(subscription, plan, { source: 'stripe_settled', referralCode: opts.referralCode });
  }
  logger.info('Stripe subscription became entitled — tier granted', {
    orgId: subscription.orgId, subscriptionId, previousStatus: opts.previousStatus, tier: plan.tier,
  });
}

/**
 * Handle subscription deletion from Stripe.
 * Marks subscription as canceled and downgrades the org to developer tier.
 */
export async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription): Promise<void> {
  const externalId = stripeSubscription.id;
  const subscription = await findSubscriptionByStripeId(externalId);

  if (!subscription) {
    logger.warn('No subscription found for deleted Stripe subscription', { externalId });
    return;
  }

  const previousStatus = subscription.status;
  subscription.status = 'canceled';
  subscription.cancelAtPeriodEnd = false;
  // Detach any coupon + forfeit the local usage-credit mirror (Stripe balance
  // persists for a future reactivation). Price-only; entitlements handled below.
  clearDiscountsOnCancel(subscription);
  await subscription.save();

  // Downgrade to developer tier
  await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());

  await createBillingEvent(subscription.orgId, 'subscription_canceled', {
    provider: 'stripe',
    previousStatus,
    newStatus: 'canceled',
    externalId,
  }, subscription._id.toString());

  logger.info('Stripe subscription deleted — org downgraded', {
    orgId: subscription.orgId,
    externalId,
  });
}
