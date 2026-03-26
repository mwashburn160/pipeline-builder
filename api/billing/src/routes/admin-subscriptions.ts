import {
  requireAuth,
  requireSystemAdmin,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  getParam,
  parseQueryInt,
  parseQueryString,
  validateBody,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router, RequestHandler } from 'express';
import { buildSubscriptionResponse, createBillingEvent, syncTierToQuotaService } from '../helpers/billing-helpers';
import { BillingEvent } from '../models/billing-event';
import { Plan } from '../models/plan';
import { Subscription } from '../models/subscription';
import { AdminSubscriptionUpdateSchema } from '../validation/schemas';

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

  // GET /billing/admin/subscriptions — list all subscriptions

  router.get(
    '/admin/subscriptions',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
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

      ctx.log('COMPLETED', 'Listed all subscriptions', { total, limit, offset });
      return sendSuccess(res, 200, { subscriptions: result, total, limit, offset });
    }, { requireOrgId: false }),
  );

  // PUT /billing/admin/subscriptions/:id — admin override subscription

  router.put(
    '/admin/subscriptions/:id',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const subscriptionId = getParam(req.params, 'id');
      const validation = validateBody(req, AdminSubscriptionUpdateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }
      const { planId, status, interval, cancelAtPeriodEnd } = validation.value;

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

      ctx.log('COMPLETED', 'Admin updated subscription', { subscriptionId, planId, status });

      return sendSuccess(res, 200, {
        subscription: buildSubscriptionResponse(subscription),
      });
    }, { requireOrgId: false }),
  );

  // GET /billing/admin/events — list billing events

  router.get(
    '/admin/events',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
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

      ctx.log('COMPLETED', 'Listed billing events', { total, limit, offset });
      return sendSuccess(res, 200, { events: result, total, limit, offset });
    }, { requireOrgId: false }),
  );

  return router;
}
