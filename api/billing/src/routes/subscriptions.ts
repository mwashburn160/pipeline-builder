/**
 * @module routes/subscriptions
 * @description Subscription management routes (authenticated).
 *
 * GET  /billing/subscriptions                — Get current org subscription
 * POST /billing/subscriptions                — Create subscription
 * PUT  /billing/subscriptions/:id            — Change plan or interval
 * POST /billing/subscriptions/:id/cancel     — Cancel at period end
 * POST /billing/subscriptions/:id/reactivate — Reactivate canceled subscription
 */

import {
  authenticateToken,
  isSystemAdmin,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
  validateBody,
} from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
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

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/** Only system administrators can create, change, cancel, or reactivate subscriptions. */
function requireSysAdmin(req: Request, res: Response, next: () => void): void {
  if (!isSystemAdmin(req)) {
    return sendError(
      res, 403,
      'Only system administrators can modify subscriptions.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }
  next();
}

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

  // ---------------------------------------------------------------------------
  // GET /billing/subscriptions — get current org subscription
  // ---------------------------------------------------------------------------

  router.get(
    '/subscriptions',
    authenticateToken(AUTH_OPTS) as RequestHandler,
    async (req: Request, res: Response) => {
      const orgId = req.user?.organizationId;
      if (!orgId) {
        return sendError(res, 400, 'Organization ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
      }

      try {
        const subscription = await Subscription.findOne({ orgId, status: 'active' }).lean();

        if (!subscription) {
          return sendSuccess(res, 200, { subscription: null });
        }

        const plan = await Plan.findById(subscription.planId).lean();

        return sendSuccess(res, 200, {
          subscription: buildSubscriptionResponse(subscription, plan?.name ?? subscription.planId, plan?.tier),
        });
      } catch (error) {
        logger.error('Failed to get subscription', { error: errorMessage(error), orgId });
        return sendError(res, 500, 'Failed to get subscription', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /billing/subscriptions — create a new subscription
  // ---------------------------------------------------------------------------

  router.post(
    '/subscriptions',
    authenticateToken(AUTH_OPTS) as RequestHandler,
    requireSysAdmin as RequestHandler,
    async (req: Request, res: Response) => {
      const orgId = req.user?.organizationId;
      if (!orgId) {
        return sendError(res, 400, 'Organization ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
      }

      const validation = validateBody(req, SubscriptionCreateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }
      const { planId, interval } = validation.value;

      try {
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
      } catch (error) {
        logger.error('Failed to create subscription', { error: errorMessage(error), orgId });
        return sendError(res, 500, 'Failed to create subscription', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PUT /billing/subscriptions/:id — change plan or interval
  // ---------------------------------------------------------------------------

  router.put(
    '/subscriptions/:id',
    authenticateToken(AUTH_OPTS) as RequestHandler,
    requireSysAdmin as RequestHandler,
    async (req: Request, res: Response) => {
      const orgId = req.user?.organizationId;
      if (!orgId) {
        return sendError(res, 400, 'Organization ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
      }

      const subscriptionId = getParam(req.params, 'id');
      const validation = validateBody(req, SubscriptionUpdateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }
      const { planId, interval } = validation.value;

      if (!planId && !interval) {
        return sendError(res, 400, 'At least planId or interval is required', ErrorCode.VALIDATION_ERROR);
      }

      try {
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
      } catch (error) {
        logger.error('Failed to update subscription', { error: errorMessage(error), orgId });
        return sendError(res, 500, 'Failed to update subscription', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /billing/subscriptions/:id/cancel — cancel at period end
  // ---------------------------------------------------------------------------

  router.post(
    '/subscriptions/:id/cancel',
    authenticateToken(AUTH_OPTS) as RequestHandler,
    requireSysAdmin as RequestHandler,
    async (req: Request, res: Response) => {
      const orgId = req.user?.organizationId;
      if (!orgId) {
        return sendError(res, 400, 'Organization ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
      }

      const subscriptionId = getParam(req.params, 'id');

      try {
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
      } catch (error) {
        logger.error('Failed to cancel subscription', { error: errorMessage(error), orgId });
        return sendError(res, 500, 'Failed to cancel subscription', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /billing/subscriptions/:id/reactivate — undo cancellation
  // ---------------------------------------------------------------------------

  router.post(
    '/subscriptions/:id/reactivate',
    authenticateToken(AUTH_OPTS) as RequestHandler,
    requireSysAdmin as RequestHandler,
    async (req: Request, res: Response) => {
      const orgId = req.user?.organizationId;
      if (!orgId) {
        return sendError(res, 400, 'Organization ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
      }

      const subscriptionId = getParam(req.params, 'id');

      try {
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
      } catch (error) {
        logger.error('Failed to reactivate subscription', { error: errorMessage(error), orgId });
        return sendError(res, 500, 'Failed to reactivate subscription', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  return router;
}
