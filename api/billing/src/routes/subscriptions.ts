// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
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
import {
  buildSubscriptionResponse,
  calculatePeriodEnd,
  createBillingEvent,
  syncTierToQuotaService,
} from '../helpers/billing-helpers';
import { BillingEvent } from '../models/billing-event';
import { Plan } from '../models/plan';
import { Subscription } from '../models/subscription';
import { getPaymentProvider } from '../providers/provider-factory';
import { SubscriptionCreateSchema, SubscriptionUpdateSchema } from '../validation/schemas';

const logger = createLogger('billing-subscriptions');

/**
 * Create the subscription management router (authenticated).
 *
 * Registers * - GET /subscriptions -- get current org subscription
 * - POST /subscriptions -- create a new subscription (admin)
 * - PUT /subscriptions/:id -- change plan or interval (admin)
 * - POST /subscriptions/:id/cancel -- cancel at period end (admin)
 * - POST /subscriptions/:id/reactivate -- undo pending cancellation (admin)
 * @returns Express Router
 */
export function createSubscriptionRoutes(): Router {
  const router: Router = Router();

  // GET /billing/subscriptions  get current org subscription

  router.get('/subscriptions', withRoute(async ({ res, orgId }) => {
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

  router.post('/subscriptions', withRoute(async ({ req, res, orgId }) => {
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
      return sendError(        res, 409,
        'Organization already has an active subscription. Use PUT to change plans.',
        ErrorCode.DUPLICATE_ENTRY,
      );
    }

    // Call payment provider  pass the user's email so the provider's
    // dunning/receipt emails reach a real inbox (Stripe accepts blank but
    // then has no contact for failed-payment notifications).
    const provider = getPaymentProvider();
    const customerEmail = req.user?.email || '';
    const customerId = await provider.createCustomer(orgId, customerEmail);
    const externalResult = await provider.createSubscription(customerId, planId, interval);

    // Create subscription
    const now = new Date();
    const subscription = await Subscription.create({
      orgId,
      planId,
      status: 'active',
      interval,
      currentPeriodStart: now,
      currentPeriodEnd: calculatePeriodEnd(now, interval),
      cancelAtPeriodEnd: false,
      externalId: externalResult.externalId,
      externalCustomerId: externalResult.externalCustomerId,
    });

    // Sync tier to quota service via a freshly-minted service token rather
    // than forwarding the user's bearer. The quota service trusts billing
    // as a peer service; forwarding the user token would mean a compromised
    // quota service receives the user's full session credential.
    const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId });
    await syncTierToQuotaService(orgId, plan.tier, serviceAuth);

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

  router.put('/subscriptions/:id', withRoute(async ({ req, res, orgId }) => {
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
      subscription.currentPeriodEnd = calculatePeriodEnd(        subscription.currentPeriodStart, interval,
      );

      await createBillingEvent(orgId, 'interval_changed', {
        oldInterval, newInterval: interval,
      }, subscriptionId);
    }

    await subscription.save();

    // Sync tier if plan changed. Use a service token rather than forwarding
    // the caller's bearer (see create-subscription comment for rationale).
    if (plan) {
      const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId });
      await syncTierToQuotaService(orgId, plan.tier, serviceAuth);
    }

    logger.info('Subscription updated', { orgId, subscriptionId, planId, interval });

    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription),
    });
  }));

  // POST /billing/subscriptions/:id/cancel  cancel at period end

  router.post('/subscriptions/:id/cancel', withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active',
    });

    if (!subscription) {
      return sendError(res, 404, 'Active subscription not found', ErrorCode.NOT_FOUND);
    }

    subscription.cancelAtPeriodEnd = true;
    await subscription.save();

    await getPaymentProvider().cancelSubscription(subscription.externalId || '');

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

  // DELETE /billing/subscriptions/by-org/:orgId â€ cascade hook.
  // Sysadmin / service-token only. Cancels and removes every subscription
  // + event for the org. Idempotent: missing org â†’ 200 with `deleted: 0`.
  //
  // The platform's org-cascade-service calls this with a service-minted
  // token; user-initiated org deletes never reach this path (they go
  // through admin.org.delete on platform, which fires us internally).
  router.delete('/subscriptions/by-org/:orgId', withRoute(async ({ req, res, orgId }) => {
    // The route uses the path:orgId, but withRoute also pulls the caller's
    // orgId from the JWT  only system org or matching org may delete.
    const targetOrgId = getParam(req.params, 'orgId');
    if (!targetOrgId) return sendError(res, 400, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
    if (orgId !== 'system' && orgId !== targetOrgId) {
      return sendError(res, 403, 'Cannot delete subscriptions for another org', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

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
            error: err instanceof Error ? err.message: String(err),
          });
        }
      }
    }

    const subDelete = await Subscription.deleteMany({ orgId: targetOrgId });

    // Drop billing events too  they're scoped to the org and have no
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
  }));

  // POST /billing/subscriptions/:id/reactivate  undo cancellation

  router.post('/subscriptions/:id/reactivate', withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active', cancelAtPeriodEnd: true,
    });

    if (!subscription) {
      return sendError(        res, 404,
        'No canceled subscription found to reactivate',
        ErrorCode.NOT_FOUND,
      );
    }

    subscription.cancelAtPeriodEnd = false;
    await subscription.save();

    await getPaymentProvider().reactivateSubscription(subscription.externalId || '');

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
