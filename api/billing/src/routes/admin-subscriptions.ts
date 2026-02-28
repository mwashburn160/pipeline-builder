/**
 * @module routes/admin-subscriptions
 * @description Admin-only billing routes (system admin required).
 *
 * GET  /billing/admin/subscriptions          — List all subscriptions
 * PUT  /billing/admin/subscriptions/:id      — Admin override subscription
 * GET  /billing/admin/events                 — List billing events
 */

import {
  requireAuth,
  requireSystemAdmin,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
  parseQueryInt,
  parseQueryString,
  validateBody,
} from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
import { buildSubscriptionResponse, createBillingEvent, syncTierToQuotaService } from '../helpers/billing-helpers';
import { BillingEvent } from '../models/billing-event';
import { Plan } from '../models/plan';
import { Subscription } from '../models/subscription';
import { AdminSubscriptionUpdateSchema } from '../validation/schemas';

const logger = createLogger('billing-admin');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * Create the admin-only billing router (system admin required).
 *
 * Registers:
 * - GET /admin/subscriptions      -- list all subscriptions (paginated)
 * - PUT /admin/subscriptions/:id  -- admin override on a subscription
 * - GET /admin/events             -- list billing events (paginated)
 * @returns Express Router
 */
export function createAdminSubscriptionRoutes(): Router {
  const router: Router = Router();

  // ---------------------------------------------------------------------------
  // GET /billing/admin/subscriptions — list all subscriptions
  // ---------------------------------------------------------------------------

  router.get(
    '/admin/subscriptions',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    async (req: Request, res: Response) => {
      try {
        const limit = parseQueryInt(req.query.limit, 50);
        const offset = parseQueryInt(req.query.offset, 0);
        const status = parseQueryString(req.query.status);

        const filter: Record<string, unknown> = {};
        if (status) filter.status = status;

        const [subscriptions, total] = await Promise.all([
          Subscription.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
          Subscription.countDocuments(filter),
        ]);

        const result = subscriptions.map((sub) => buildSubscriptionResponse(sub));

        return sendSuccess(res, 200, { subscriptions: result, total, limit, offset });
      } catch (error) {
        logger.error('Failed to list subscriptions', { error: errorMessage(error) });
        return sendError(res, 500, 'Failed to list subscriptions', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PUT /billing/admin/subscriptions/:id — admin override subscription
  // ---------------------------------------------------------------------------

  router.put(
    '/admin/subscriptions/:id',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    async (req: Request, res: Response) => {
      const subscriptionId = getParam(req.params, 'id');
      const validation = validateBody(req, AdminSubscriptionUpdateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }
      const { planId, status, interval, cancelAtPeriodEnd } = validation.value;

      try {
        const subscription = await Subscription.findById(subscriptionId);
        if (!subscription) {
          return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);
        }

        const orgId = subscription.orgId;

        if (planId) {
          const plan = await Plan.findOne({ _id: planId, isActive: true });
          if (!plan) {
            return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
          }
          const oldPlanId = subscription.planId;
          subscription.planId = planId;

          // Sync tier
          const authHeader = req.headers.authorization || '';
          await syncTierToQuotaService(orgId, plan.tier, authHeader);
          await createBillingEvent(orgId, 'plan_changed', { oldPlanId, newPlanId: planId }, subscriptionId);
        }

        if (status && status !== subscription.status) {
          subscription.status = status;
          await createBillingEvent(orgId, 'subscription_updated', { status }, subscriptionId);
        } else if (status) {
          subscription.status = status;
        }

        if (interval && interval !== subscription.interval) {
          const oldInterval = subscription.interval;
          subscription.interval = interval;
          await createBillingEvent(orgId, 'interval_changed', { oldInterval, newInterval: interval }, subscriptionId);
        } else if (interval) {
          subscription.interval = interval;
        }

        if (cancelAtPeriodEnd !== undefined) subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;

        await subscription.save();

        logger.info('Admin updated subscription', { subscriptionId, planId, status });

        return sendSuccess(res, 200, {
          subscription: buildSubscriptionResponse(subscription),
        });
      } catch (error) {
        logger.error('Failed to update subscription', { error: errorMessage(error) });
        return sendError(res, 500, 'Failed to update subscription', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /billing/admin/events — list billing events
  // ---------------------------------------------------------------------------

  router.get(
    '/admin/events',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    async (req: Request, res: Response) => {
      try {
        const limit = parseQueryInt(req.query.limit, 50);
        const offset = parseQueryInt(req.query.offset, 0);
        const orgId = parseQueryString(req.query.orgId);

        const filter: Record<string, unknown> = {};
        if (orgId) filter.orgId = orgId;

        const [events, total] = await Promise.all([
          BillingEvent.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
          BillingEvent.countDocuments(filter),
        ]);

        const result = events.map((event) => ({
          id: event._id.toString(),
          orgId: event.orgId,
          subscriptionId: event.subscriptionId,
          type: event.type,
          details: event.details,
          createdAt: event.createdAt.toISOString(),
        }));

        return sendSuccess(res, 200, { events: result, total, limit, offset });
      } catch (error) {
        logger.error('Failed to list billing events', { error: errorMessage(error) });
        return sendError(res, 500, 'Failed to list billing events', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  return router;
}
