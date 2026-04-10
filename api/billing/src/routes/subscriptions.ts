// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  getParam,
  validateBody,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import {
  buildSubscriptionResponse,
  calculatePeriodEnd,
  createBillingEvent,
  syncTierToQuotaService,
} from '../helpers/billing-helpers';
import { Plan } from '../models/plan';
import { Subscription } from '../models/subscription';
import { getPaymentProvider } from '../providers/provider-factory';
import { SubscriptionCreateSchema, SubscriptionUpdateSchema } from '../validation/schemas';

const logger = createLogger('billing-subscriptions');

/**
 * Create the subscription management router (authenticated).
 *
 * Registers:
 * - GET  /subscriptions                -- get current org subscription
 * - POST /subscriptions                -- create a new subscription (admin)
 * - PUT  /subscriptions/:id            -- change plan or interval (admin)
 * - POST /subscriptions/:id/cancel     -- cancel at period end (admin)
 * - POST /subscriptions/:id/reactivate -- undo pending cancellation (admin)
 * @returns Express Router
 */
export function createSubscriptionRoutes(): Router {
  const router: Router = Router();

  // GET /billing/subscriptions — get current org subscription

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

  // POST /billing/subscriptions — create a new subscription

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
      return sendError(
        res, 409,
        'Organization already has an active subscription. Use PUT to change plans.',
        ErrorCode.DUPLICATE_ENTRY,
      );
    }

    // Call payment provider
    const provider = getPaymentProvider();
    const customerId = await provider.createCustomer(orgId, '');
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

    // Sync tier to quota service
    const authHeader = req.headers.authorization || '';
    await syncTierToQuotaService(orgId, plan.tier, authHeader);

    // Log billing event
    await createBillingEvent(orgId, 'subscription_created', {
      planId, interval, tier: plan.tier,
    }, subscription._id.toString());

    logger.info('Subscription created', { orgId, planId, interval });

    return sendSuccess(res, 201, {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
    });
  }));

  // PUT /billing/subscriptions/:id — change plan or interval

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
      subscription.currentPeriodEnd = calculatePeriodEnd(
        subscription.currentPeriodStart, interval,
      );

      await createBillingEvent(orgId, 'interval_changed', {
        oldInterval, newInterval: interval,
      }, subscriptionId);
    }

    await subscription.save();

    // Sync tier if plan changed
    if (plan) {
      const authHeader = req.headers.authorization || '';
      await syncTierToQuotaService(orgId, plan.tier, authHeader);
    }

    logger.info('Subscription updated', { orgId, subscriptionId, planId, interval });

    return sendSuccess(res, 200, {
      subscription: buildSubscriptionResponse(subscription),
    });
  }));

  // POST /billing/subscriptions/:id/cancel — cancel at period end

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

  // POST /billing/subscriptions/:id/reactivate — undo cancellation

  router.post('/subscriptions/:id/reactivate', withRoute(async ({ req, res, orgId }) => {
    const subscriptionId = getParam(req.params, 'id');

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active', cancelAtPeriodEnd: true,
    });

    if (!subscription) {
      return sendError(
        res, 404,
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
