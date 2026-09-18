// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  audited,
  requireAuth,
  requirePermission,
  requireStepUp,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  getParam,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { applyPlanTierChange, applyTierIncludedAddonPrune } from '../helpers/addon-prune.js';
import {
  billingServiceAuth,
  buildSubscriptionResponse,
  calculatePeriodEnd,
  checkEntitlementOvercap,
  createBillingEvent,
  MANAGEABLE_SUBSCRIPTION_STATUSES,
  syncEntitlements,
  syncProviderAddons,
} from '../helpers/billing-helpers.js';
import type { PrunedAddon } from '../helpers/billing-helpers.js';
import { evaluatePromotions, clawbackRecentPromotions } from '../helpers/promotion-engine.js';
import { runSignupPromotions } from '../helpers/signup-promotions.js';
import { mapStripeStatus } from '../helpers/stripe-helpers.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { getAuditClient } from '../services/audit.js';
import { SubscriptionCreateSchema, SubscriptionUpdateSchema } from '../validation/schemas.js';

const logger = createLogger('billing-subscriptions');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * Shared preflight for BOTH subscription-create entry points (hosted Checkout and
 * the direct create): validate the body, refuse Marketplace-billed deployments
 * (entitlements come from AWS there — see /marketplace/register), resolve the
 * active plan, and reject an org that already holds a manageable OR still-settling
 * (`incomplete`) subscription — otherwise a second create/checkout mints another
 * provider subscription while the first is still live at the provider (~23h).
 *
 * Sends the error response itself and returns `null` on any rejection.
 */
async function preflightCreate(req: Request, res: Response, orgId: string) {
  const validation = validateBody(req, SubscriptionCreateSchema);
  if (!validation.ok) {
    sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    return null;
  }
  // AWS Marketplace entitlements are the source of truth — an org can't
  // self-serve a subscription here (createCustomer would otherwise throw and
  // surface as a 500). Point the caller at the Marketplace claim flow instead.
  if (config.billingProvider === 'aws-marketplace') {
    sendError(
      res, 409,
      'Subscriptions are provisioned through AWS Marketplace. Complete setup from your AWS Marketplace subscription (see /marketplace/register).',
      ErrorCode.CONFLICT,
    );
    return null;
  }
  const plan = await Plan.findOne({ _id: validation.value.planId, isActive: true });
  if (!plan) {
    sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
    return null;
  }
  const existing = await Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES, 'incomplete'] } });
  if (existing) {
    sendError(res, 409, 'Organization already has a subscription. Use PUT to change plans.', ErrorCode.DUPLICATE_ENTRY);
    return null;
  }
  // Pass the user's email to the provider so dunning/receipt emails reach a real
  // inbox (Stripe accepts undefined but then has no failed-payment contact).
  const rawEmail = req.user?.email;
  const customerEmail = typeof rawEmail === 'string' && rawEmail.length > 0 ? rawEmail : undefined;
  return { ...validation.value, plan, customerEmail };
}

/**
 * Create the subscription management router (authenticated).
 *
 * Registers:
 * - GET /subscriptions -- get current org subscription
 * - POST /subscriptions -- create a new subscription (admin)
 * - PUT /subscriptions/:id -- change plan or interval (admin)
 * - POST /subscriptions/:id/cancel -- cancel at period end (admin)
 * - POST /subscriptions/:id/reactivate -- undo pending cancellation (admin)
 *
 * The org-cascade DELETE /subscriptions/by-org/:orgId lives in the admin router.
 * @returns Express Router
 */
export function createSubscriptionRoutes(): Router {
  const router: Router = Router();

  // GET /billing/subscriptions  get current org subscription

  router.get('/subscriptions', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ res, orgId }) => {
    // Include trialing / past_due, not just active — a trial sub grants
    // entitlements and a past_due sub is in dunning grace; both must be visible
    // (and manageable) or the customer can't see/cancel/fix them.
    const subscription = await Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } }).lean();

    if (!subscription) {
      return sendSuccess(res, 200, { subscription: null });
    }

    const plan = await Plan.findById(subscription.planId).lean();

    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan?.name ?? subscription.planId, plan?.tier),
    });
  }));

  // POST /billing/subscriptions/checkout  start a hosted Checkout to collect a
  // card + create a PAID subscription (Stripe self-serve). Returns { url } to
  // redirect to; the local subscription + entitlements are provisioned by the
  // `customer.subscription.created` webhook on completion (no cardless
  // `incomplete` orphan). Providers without Checkout (stub) fall back to the
  // direct create; Marketplace bills externally.
  router.post('/subscriptions/checkout', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const pre = await preflightCreate(req, res, orgId);
    if (!pre) return;
    const { planId, interval, plan, customerEmail } = pre;

    const provider = getPaymentProvider();
    if (!provider.createCheckoutSession) {
      // stub (no card needed) — the client should use the direct create instead.
      return sendError(res, 501, 'The configured billing provider has no hosted checkout; use POST /subscriptions.', ErrorCode.NOT_IMPLEMENTED);
    }
    // A free plan needs no checkout — create it directly via POST /subscriptions.
    if (plan.prices.monthly === 0 && plan.prices.annual === 0) {
      return sendError(res, 400, 'This plan is free — use POST /subscriptions.', ErrorCode.VALIDATION_ERROR);
    }

    // Reuse the org's existing Stripe customer (from a prior/cancelled sub) so its
    // balance / usage-credit mirror carries over and we don't strand orphan
    // customers on abandoned checkouts; else mint one (idempotent per org).
    const prior = await Subscription.findOne({ orgId, externalCustomerId: { $ne: null } });
    const customerId = prior?.externalCustomerId
      || await provider.createCustomer(orgId, customerEmail, `checkout_cust_${orgId}`);

    const origin = (req.headers.origin as string | undefined) || config.frontendUrl;
    if (!origin) return sendError(res, 400, 'Cannot determine a return URL for checkout (no Origin header or configured frontend URL)', ErrorCode.VALIDATION_ERROR);
    const base = `${origin.replace(/\/$/, '')}/dashboard/billing`;
    const url = await provider.createCheckoutSession(customerId, planId, interval, {
      orgId,
      successUrl: `${base}?checkout=success`,
      cancelUrl: `${base}?checkout=cancelled`,
      ...(pre.referralCode ? { referralCode: pre.referralCode } : {}),
    });
    logger.info('Created checkout session', { orgId, planId, interval });
    return sendSuccess(res, 200, { url });
  }));

  // POST /billing/subscriptions  create a new subscription

  router.post('/subscriptions', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, audited('billing.subscription.create'), withRoute(async ({ req, res, orgId }) => {
    const pre = await preflightCreate(req, res, orgId);
    if (!pre) return;
    const { planId, interval, plan, customerEmail, referralCode } = pre;

    // Reserve the local uniqueness slot BEFORE any external provider work.
    // Previously the provider's createCustomer/createSubscription ran first, so a
    // concurrent/retried POST minted real Stripe objects and then 500'd on the
    // unique-index collision, leaking orphaned Stripe state. Inserting the local
    // row first means the loser trips the `{orgId,status:'active'}` unique index
    // (11000) and gets a clean 409 without ever touching the provider. The row is
    // created externally-unbound (externalId/externalCustomerId null) and rolled
    // back if the provider calls fail, so a failure can't wedge the org behind a
    // phantom active subscription.
    const now = new Date();
    let subscription;
    try {
      subscription = await Subscription.create({
        orgId,
        planId,
        status: 'active',
        interval,
        currentPeriodStart: now,
        currentPeriodEnd: calculatePeriodEnd(now, interval),
        cancelAtPeriodEnd: false,
        // Stamp the configured provider so lifecycle webhooks can find this row.
        // The Stripe webhook lookup filters on `metadata.provider: 'stripe'`;
        // without this, every Stripe subscription.updated/deleted + invoice.*
        // webhook resolved null and silently no-op'd (missed past_due/cancel).
        metadata: { provider: config.billingProvider },
      });
    } catch (err) {
      // Concurrent create lost the unique-index race — the org already has (or
      // is mid-creating) an active subscription. Return the same 409 the
      // pre-check returns rather than a 500.
      if ((err as { code?: number }).code === 11000) {
        return sendError(res, 409,
          'Organization already has an active subscription. Use PUT to change plans.',
          ErrorCode.DUPLICATE_ENTRY,
        );
      }
      throw err;
    }

    // Now mint the external objects, keyed by the reserved row's id so a retry
    // reuses the same idempotency key (providers that support it dedupe rather
    // than double-create). On any provider failure, roll the reservation back.
    const idempotencyKey = subscription._id.toString();
    try {
      const provider = getPaymentProvider();
      const customerId = await provider.createCustomer(orgId, customerEmail, `cust_${idempotencyKey}`);
      const externalResult = await provider.createSubscription(customerId, planId, interval, `sub_${idempotencyKey}`);
      subscription.externalId = externalResult.externalId;
      subscription.externalCustomerId = externalResult.externalCustomerId;
      // Reconcile the local status to the provider's REAL state. The row was
      // reserved as `active` purely to trip the {orgId,status:'active'}
      // uniqueness slot BEFORE any provider call; that reservation must not be
      // mistaken for a settled subscription. A Stripe sub created with no card
      // lands `incomplete`, so blindly persisting `active` would hand the org
      // full paid caps ~23h before Stripe deletes the sub. mapStripeStatus
      // normalizes the provider's status string (stub/marketplace return
      // `active`).
      subscription.status = mapStripeStatus(externalResult.status);
      // A still-settling sub gets its signup credit on the later
      // `customer.subscription.updated`→active webhook; stash the referral code so
      // that path can honor it (Checkout carries it in Stripe metadata instead).
      if (referralCode && subscription.status !== 'active' && subscription.status !== 'trialing') {
        subscription.metadata = { ...subscription.metadata, pendingReferralCode: referralCode };
      }
      await subscription.save();
    } catch (err) {
      await Subscription.deleteOne({ _id: subscription._id }).catch(() => { /* best-effort rollback */ });
      throw err;
    }

    // Grant the paid tier ONLY when the provider's status is entitlement-worthy
    // (active or trialing). For incomplete/past_due/etc. we keep the persisted
    // subscription row but leave the org on its unprovisioned/developer tier —
    // the later `customer.subscription.updated`→active webhook (plus the Tier-1
    // reconciler) grants entitlements once payment settles. Gating on PROVIDER
    // STATUS (not a blanket card-required check) keeps trials working.
    //
    // Sync via a freshly-minted service token rather than forwarding the user's
    // bearer: the quota service trusts billing as a peer service; forwarding the
    // user token would leak their full session credential to a compromised quota
    // service.
    const entitlementWorthy = subscription.status === 'active' || subscription.status === 'trialing';
    if (entitlementWorthy) {
      await syncEntitlements(orgId, plan.tier, billingServiceAuth(orgId), subscription._id.toString());
    }

    // Log billing event
    await createBillingEvent(orgId, 'subscription_created', {
      planId, interval, tier: plan.tier,
    }, subscription._id.toString(), req.user?.sub);

    // Mirror the new subscription to the CENTRAL audit trail (alongside the local
    // billing_events row above) — it's the financially-binding start of a paid
    // relationship. Fire-and-forget; details are an explicit plan/tier whitelist,
    // so no card/payment secret or AWS account id can reach the trail.
    getAuditClient().record({
      action: 'billing.subscription.create',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: subscription._id.toString(),
      details: { planId, interval, tier: plan.tier, status: subscription.status },
    }, 'billing');

    // Promotions + referrals: only credit an ENTITLEMENT-WORTHY signup (active/
    // trialing). An `incomplete`/`past_due` sub hasn't paid and may be deleted by
    // Stripe without a clawback path, so banking a credit / reserving campaign
    // budget for it is a leak (the settle webhook grants it later). Post-save +
    // fail-soft (atomic writes only, so no clobber of the just-saved subscription).
    if (entitlementWorthy) {
      await runSignupPromotions(subscription, plan, { source: 'subscription_create', referralCode, actorId: req.user?.sub });
    }

    logger.info('Subscription created', { orgId, planId, interval });

    return sendSuccess(res, 201, {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
    });
  }));

  // PUT /billing/subscriptions/:id  change plan or interval

  // `billing.addon.prune` rides along: a tier upgrade auto-drops any bundle the
  // destination tier now includes (applyTierIncludedAddonPrune → finalizePrunedAddons).
  router.put('/subscriptions/:id', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, audited('billing.subscription.update', 'billing.addon.prune'), withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');
    const validation = validateBody(req, SubscriptionUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { planId, interval } = validation.value;

    if (!planId && !interval) {
      return sendError(res, 400, 'At least planId or interval is required', ErrorCode.VALIDATION_ERROR);
    }

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
    });

    if (!subscription) {
      return sendError(res, 404, 'Active subscription not found', ErrorCode.NOT_FOUND);
    }

    const planChanged = Boolean(planId && planId !== subscription.planId);
    const intervalChanged = Boolean(interval && interval !== subscription.interval);

    // Bundles dropped because the destination tier now includes their feature.
    // Captured during the (pre-save) prune; their provider line-item removal +
    // audit run AFTER save (see finalizePrunedAddons below).
    let prunedAddons: PrunedAddon[] = [];

    // If changing plan, verify the new plan exists and gate the downgrade.
    let plan;
    if (planChanged && planId) {
      plan = await Plan.findOne({ _id: planId, isActive: true });
      if (!plan) {
        return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
      }
      // Downgrade gate (docs/billing-bundles.md §8): a lower tier (with the
      // account's existing add-ons) must not drop a count-quota cap below
      // current pooled usage. Structured overages drive the UI's "remove N".
      const overages = await checkEntitlementOvercap(orgId, plan.tier, subscription.addons ?? [], '');
      if (overages.length > 0) {
        return sendError(res, 409, 'This plan change would put the account over its limit — remove members/resources first', ErrorCode.PLAN_OVER_CAP, { overages });
      }
    }

    // Effective post-change plan + interval. Push BOTH to the provider in a
    // single call whenever EITHER changes: the provider selects the price via
    // `{planId}_{interval}`, so an interval-only change actually re-cadences
    // billing and a combined change applies the new plan AT the new interval's
    // price (the old split path left the provider on the stale cadence).
    const effectivePlanId = planChanged && planId ? planId : subscription.planId;
    const effectiveInterval = intervalChanged && interval ? interval : subscription.interval;

    if (planChanged || intervalChanged) {
      await getPaymentProvider().updateSubscription(subscription.externalId || '', effectivePlanId, effectiveInterval);
    }

    // Deferred post-save side effects for a plan change (sync + plan_changed
    // event + prune finalize), built pre-save but INVOKED after save so a failed
    // save can't leave the quota service / event log / provider ahead.
    let runPlanSideEffects: (() => Promise<void>) | undefined;

    if (planChanged) {
      const oldPlanId = subscription.planId;
      subscription.planId = effectivePlanId;

      // Prune any PURE-FEATURE add-on the new tier now bundles in (e.g. an
      // `advanced_reporting` bundle absorbed by an Enterprise upgrade). Without
      // this the customer keeps paying for a bundle their tier includes AND the
      // tier-filtered catalog hides it, so they can't self-service-remove it.
      // This mutates subscription.addons in memory (persisted by the save below);
      // the provider line-item removal + audit run post-save via
      // applyPlanTierChange → finalizePrunedAddons. Hybrid bundles (e.g.
      // `sso`→idpConfigs) are kept. `plan` is always set when planChanged
      // (fetched above); guard for TS.
      if (plan) {
        prunedAddons = applyTierIncludedAddonPrune(subscription, plan.tier, {
          orgId, subscriptionId: subscription._id.toString(), source: 'plan_change',
        });
        runPlanSideEffects = applyPlanTierChange(subscription, plan, {
          oldPlanId,
          newPlanId: effectivePlanId,
          pruned: prunedAddons,
          actorId: req.user?.sub,
          source: 'plan_change',
        });
      }
    }

    if (intervalChanged) {
      const oldInterval = subscription.interval;
      subscription.interval = effectiveInterval;
      // Keep the local period end consistent with the cadence pushed above.
      subscription.currentPeriodEnd = calculatePeriodEnd(subscription.currentPeriodStart, effectiveInterval);
      await createBillingEvent(orgId, 'interval_changed', {
        oldInterval, newInterval: effectiveInterval,
      }, subscriptionId, req.user?.sub);
    }

    await subscription.save();

    // Post-save side effects for a plan change: sync effective entitlements
    // (service token — never the caller's bearer; see create-subscription
    // rationale), write the plan_changed row, and remove any pruned bundles'
    // provider line items + audit trail. Runs AFTER save so a failed save can't
    // drift the quota service / event log / provider ahead of the document.
    if (runPlanSideEffects) await runPlanSideEffects();

    // An interval change must ALSO re-cadence add-on line items: the provider's
    // updateSubscription only swaps the BASE item, so without this every bundle
    // line item stays on the OLD interval's price (silent mis-billing). Rebuild
    // them at the new cadence from the current (post-prune) add-on set. Skipped
    // when there are no add-ons (nothing to re-price).
    if (intervalChanged && subscription.addons?.length) {
      await syncProviderAddons(
        subscription.externalId, subscription.addons, effectiveInterval, orgId,
        subscription._id.toString(), 'interval_change',
      );
    }

    // Promotions: auto-grant plan-change-triggered campaigns (e.g. upgrade credit).
    // Only on an actual plan change; post-side-effects + fail-soft.
    if (planChanged && plan) {
      try {
        await evaluatePromotions(orgId, subscription, 'plan_change', {
          tier: plan.tier,
          interval: subscription.interval,
          planPriceCents: plan.prices[subscription.interval],
          actorId: req.user?.sub,
        });
      } catch (promoErr) {
        logger.error('Promotion evaluation failed (plan_change)', {
          orgId, error: promoErr instanceof Error ? promoErr.message : String(promoErr),
        });
      }
    }

    // Mirror the plan/cadence change to the CENTRAL audit trail (the local
    // plan_changed / interval_changed rows are written above). Customer-driven
    // counterpart to the sysadmin `billing.tier.override`. Fire-and-forget;
    // details are an explicit plan/interval whitelist — no payment secrets.
    getAuditClient().record({
      action: 'billing.subscription.update',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: subscriptionId,
      details: {
        planId: subscription.planId,
        interval: subscription.interval,
        ...(plan ? { tier: plan.tier } : {}),
        planChanged,
        intervalChanged,
      },
    }, 'billing');

    logger.info('Subscription updated', { orgId, subscriptionId, planId, interval });

    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan?.name, plan?.tier),
    });
  }));

  // POST /billing/subscriptions/:id/cancel  cancel at period end

  router.post('/subscriptions/:id/cancel', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, requireStepUp as RequestHandler, audited('billing.subscription.cancel'), withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
    });

    if (!subscription) {
      return sendError(res, 404, 'Active subscription not found', ErrorCode.NOT_FOUND);
    }

    // Provider-first: if the upstream cancel fails after we've persisted
    // cancelAtPeriodEnd=true, the customer's UI says "canceled" but Stripe/etc.
    // keeps billing them. Roll the local flip back on provider failure so the
    // two stores can't diverge.
    subscription.cancelAtPeriodEnd = true;
    await subscription.save();
    try {
      await getPaymentProvider().cancelSubscription(subscription.externalId || '');
    } catch (err) {
      subscription.cancelAtPeriodEnd = false;
      await subscription.save();
      logger.error('Provider cancel failed; reverted local cancelAtPeriodEnd', {
        orgId, subscriptionId, error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await createBillingEvent(orgId, 'subscription_canceled', {
      planId: subscription.planId,
      cancelAtPeriodEnd: true,
      periodEnd: subscription.currentPeriodEnd.toISOString(),
    }, subscriptionId, req.user?.sub);

    // Mirror this financially-sensitive mutation to the CENTRAL audit trail
    // (in addition to the local billing_events row above). Fire-and-forget; the
    // details are an explicit whitelist of plan/subscription ids — the raw
    // subscription doc (externalCustomerId / provider tokens) is never spread in,
    // so no card/payment secret or AWS account id can reach the trail.
    getAuditClient().record({
      action: 'billing.subscription.cancel',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: subscriptionId,
      details: { planId: subscription.planId, orgId },
    }, 'billing');

    // Promotions: claw back any grants made inside the clawback window — defuses
    // signup-grab-churn. Post-event + fail-soft; never blocks the cancellation.
    try {
      await clawbackRecentPromotions(subscription, req.user?.sub);
    } catch (promoErr) {
      logger.error('Promotion clawback failed on cancel', {
        orgId, error: promoErr instanceof Error ? promoErr.message : String(promoErr),
      });
    }

    logger.info('Subscription marked for cancellation', { orgId, subscriptionId });

    return sendSuccess(res, 200, {
      message: 'Subscription will be canceled at the end of the current billing period.',
      subscription: {
        id: subscription._id.toString(),
        status: subscription.status,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      },
    });
  }));

  // POST /billing/subscriptions/:id/reactivate  undo cancellation

  router.post('/subscriptions/:id/reactivate', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, audited('billing.subscription.reactivate'), withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] }, cancelAtPeriodEnd: true,
    });

    if (!subscription) {
      return sendError( res, 404,
        'No canceled subscription found to reactivate',
        ErrorCode.NOT_FOUND,
      );
    }

    // Mirror cancel: keep local + provider state in sync by reverting the
    // local flip if the upstream reactivate fails (otherwise the user thinks
    // they're active but the provider will still terminate at period end).
    subscription.cancelAtPeriodEnd = false;
    await subscription.save();
    try {
      await getPaymentProvider().reactivateSubscription(subscription.externalId || '');
    } catch (err) {
      subscription.cancelAtPeriodEnd = true;
      await subscription.save();
      logger.error('Provider reactivate failed; reverted local cancelAtPeriodEnd', {
        orgId, subscriptionId, error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await createBillingEvent(orgId, 'subscription_reactivated', {
      planId: subscription.planId,
    }, subscriptionId, req.user?.sub);

    // Mirror the undo-cancel to the CENTRAL audit trail — the inverse of
    // `billing.subscription.cancel`, so the trail shows both sides of a churn
    // decision. Fire-and-forget; plan id only, no payment secrets.
    getAuditClient().record({
      action: 'billing.subscription.reactivate',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: subscriptionId,
      details: { planId: subscription.planId, orgId },
    }, 'billing');

    logger.info('Subscription reactivated', { orgId, subscriptionId });

    return sendSuccess(res, 200, {
      message: 'Subscription has been reactivated.',
      subscription: {
        id: subscription._id.toString(),
        status: subscription.status,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      },
    });
  }));

  return router;
}
