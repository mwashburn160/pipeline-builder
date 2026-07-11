// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  requirePermission,
  requireSystemAdmin,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  getParam,
  getServiceAuthHeader,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import {
  buildSubscriptionResponse,
  calculatePeriodEnd,
  checkEntitlementOvercap,
  createBillingEvent,
  syncEntitlements,
} from '../helpers/billing-helpers.js';
import { BillingEvent } from '../models/billing-event.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { SubscriptionCreateSchema, SubscriptionUpdateSchema } from '../validation/schemas.js';

const logger = createLogger('billing-subscriptions');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * Create the subscription management router (authenticated).
 *
 * Registers:
 * - GET /subscriptions -- get current org subscription
 * - POST /subscriptions -- create a new subscription (admin)
 * - PUT /subscriptions/:id -- change plan or interval (admin)
 * - POST /subscriptions/:id/cancel -- cancel at period end (admin)
 * - POST /subscriptions/:id/reactivate -- undo pending cancellation (admin)
 * @returns Express Router
 */
export function createSubscriptionRoutes(): Router {
  const router: Router = Router();

  // GET /billing/subscriptions  get current org subscription

  router.get('/subscriptions', requireAuth(AUTH_OPTS) as RequestHandler, withRoute(async ({ res, orgId }) => {
    const subscription = await Subscription.findOne({ orgId, status: 'active' }).lean();

    if (!subscription) {
      return sendSuccess(res, 200, { subscription: null });
    }

    const plan = await Plan.findById(subscription.planId).lean();

    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan?.name ?? subscription.planId, plan?.tier),
    });
  }));

  // POST /billing/subscriptions  create a new subscription

  router.post('/subscriptions', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const validation = validateBody(req, SubscriptionCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { planId, interval } = validation.value;

    // Verify plan exists
    const plan = await Plan.findOne({ _id: planId, isActive: true });
    if (!plan) {
      return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
    }

    // Check for existing active subscription
    const existing = await Subscription.findOne({ orgId, status: 'active' });
    if (existing) {
      return sendError( res, 409,
        'Organization already has an active subscription. Use PUT to change plans.',
        ErrorCode.DUPLICATE_ENTRY,
      );
    }

    // Pass the user's email to the provider so dunning/receipt emails reach
    // a real inbox. Stripe accepts undefined but then has no contact for
    // failed-payment notifications.
    // TODO: source email from JWT issuance or platform lookup once it's
    // populated on req.user; current AUTH path leaves email unset.
    const rawEmail = req.user?.email;
    const customerEmail = typeof rawEmail === 'string' && rawEmail.length > 0 ? rawEmail : undefined;

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
      await subscription.save();
    } catch (err) {
      await Subscription.deleteOne({ _id: subscription._id }).catch(() => { /* best-effort rollback */ });
      throw err;
    }

    // Sync tier to quota service via a freshly-minted service token rather
    // than forwarding the user's bearer. The quota service trusts billing
    // as a peer service; forwarding the user token would mean a compromised
    // quota service receives the user's full session credential.
    const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
    await syncEntitlements(orgId, plan.tier, serviceAuth, subscription._id.toString());

    // Log billing event
    await createBillingEvent(orgId, 'subscription_created', {
      planId, interval, tier: plan.tier,
    }, subscription._id.toString());

    logger.info('Subscription created', { orgId, planId, interval });

    return sendSuccess(res, 201, {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
    });
  }));

  // PUT /billing/subscriptions/:id  change plan or interval

  router.put('/subscriptions/:id', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
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
      _id: subscriptionId, orgId, status: 'active',
    });

    if (!subscription) {
      return sendError(res, 404, 'Active subscription not found', ErrorCode.NOT_FOUND);
    }

    // If changing plan, verify new plan exists
    let plan;
    if (planId && planId !== subscription.planId) {
      plan = await Plan.findOne({ _id: planId, isActive: true });
      if (!plan) {
        return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
      }
      // Downgrade gate (docs/billing-bundles.md §8): a lower tier (with the
      // account's existing add-ons) must not drop a count-quota cap below
      // current pooled usage. Structured overages drive the UI's "remove N".
      const overages = await checkEntitlementOvercap(orgId, plan.tier, subscription.addons ?? [], '');
      if (overages.length > 0) {
        return sendError(res, 409, 'This plan change would put the account over its limit — remove members/resources first', 'PLAN_OVER_CAP', { overages });
      }
      const oldPlanId = subscription.planId;
      subscription.planId = planId;

      await getPaymentProvider().updateSubscription(subscription.externalId || '', planId);

      await createBillingEvent(orgId, 'plan_changed', {
        oldPlanId, newPlanId: planId,
      }, subscriptionId);
    }

    // If changing interval
    if (interval && interval !== subscription.interval) {
      const oldInterval = subscription.interval;
      subscription.interval = interval;
      subscription.currentPeriodEnd = calculatePeriodEnd( subscription.currentPeriodStart, interval,
      );

      await createBillingEvent(orgId, 'interval_changed', {
        oldInterval, newInterval: interval,
      }, subscriptionId);
    }

    await subscription.save();

    // Sync tier if plan changed. Use a service token rather than forwarding
    // the caller's bearer (see create-subscription comment for rationale).
    // Pass the current add-ons so a plan change preserves purchased bundle
    // grants instead of resetting to tier-base-only limits.
    if (plan) {
      const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
      await syncEntitlements(orgId, plan.tier, serviceAuth, subscriptionId, subscription.addons ?? []);
    }

    logger.info('Subscription updated', { orgId, subscriptionId, planId, interval });

    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription, plan?.name, plan?.tier),
    });
  }));

  // POST /billing/subscriptions/:id/cancel  cancel at period end

  router.post('/subscriptions/:id/cancel', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active',
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
    }, subscriptionId);

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

  // DELETE /billing/subscriptions/by-org/:orgId � cascade hook.
  // Sysadmin / service-token only. Cancels and removes every subscription
  // + event for the org. Idempotent: missing org → 200 with `deleted: 0`.
  //
  // The platform's org-cascade-service calls this with a service-minted
  // token; user-initiated org deletes never reach this path (they go
  // through admin.org.delete on platform, which fires us internally).
  router.delete(
    '/subscriptions/by-org/:orgId',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res }) => {
      const targetOrgId = getParam(req.params, 'orgId');
      if (!targetOrgId) return sendError(res, 400, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);

      // Cancel any active subscription at the provider first so we don't
      // leave billable state running after our local rows are gone.
      const active = await Subscription.find({ orgId: targetOrgId, status: 'active' });
      for (const sub of active) {
        if (sub.externalId) {
          try {
            await getPaymentProvider().cancelSubscription(sub.externalId);
          } catch (err) {
            logger.warn('Provider cancel failed during cascade  continuing with local delete', {
              orgId: targetOrgId,
              subscriptionId: sub._id?.toString(),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const subDelete = await Subscription.deleteMany({ orgId: targetOrgId });

      // Drop billing events too — they're scoped to the org and have no
      // independent purpose once the subscription is gone. Audit retention
      // lives in platform's audit_events collection, not here.
      const eventDelete = await BillingEvent.deleteMany({ orgId: targetOrgId });

      logger.info('Subscription cascade complete', {
        orgId: targetOrgId,
        subscriptions: subDelete.deletedCount ?? 0,
        events: eventDelete.deletedCount ?? 0,
      });

      return sendSuccess(res, 200, {
        deleted: subDelete.deletedCount ?? 0,
        events: eventDelete.deletedCount ?? 0,
      });
    }, { requireOrgId: false }),
  );

  // POST /billing/subscriptions/:id/reactivate  undo cancellation

  router.post('/subscriptions/:id/reactivate', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active', cancelAtPeriodEnd: true,
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
    }, subscriptionId);

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
