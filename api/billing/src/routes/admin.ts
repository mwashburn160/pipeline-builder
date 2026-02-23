/**
 * @module routes/admin
 * @description Admin-only billing routes (system admin required).
 *
 * GET  /billing/admin/subscriptions          — List all subscriptions
 * PUT  /billing/admin/subscriptions/:id      — Admin override subscription
 * GET  /billing/admin/events                 — List billing events
 */

import {
  authenticateToken,
  isSystemAdmin,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
  parseQueryInt,
  parseQueryString,
} from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
import { syncTierToQuotaService } from '../helpers/billing-helpers';
import { BillingEvent } from '../models/billing-event';
import { Plan } from '../models/plan';
import { Subscription } from '../models/subscription';

const logger = createLogger('billing-admin');
const router: Router = Router();

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/** Middleware to require system admin. */
function requireAdmin(req: Request, res: Response, next: () => void): void {
  if (!isSystemAdmin(req)) {
    return sendError(
      res, 403,
      'Access denied. Only system administrators can perform this action.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /billing/admin/subscriptions — list all subscriptions
// ---------------------------------------------------------------------------

router.get(
  '/admin/subscriptions',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  requireAdmin as RequestHandler,
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

      const result = subscriptions.map((sub) => ({
        id: sub._id.toString(),
        orgId: sub.orgId,
        planId: sub.planId,
        status: sub.status,
        interval: sub.interval,
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        createdAt: sub.createdAt.toISOString(),
        updatedAt: sub.updatedAt.toISOString(),
      }));

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
  authenticateToken(AUTH_OPTS) as RequestHandler,
  requireAdmin as RequestHandler,
  async (req: Request, res: Response) => {
    const subscriptionId = getParam(req.params, 'id');
    const { planId, status, interval, cancelAtPeriodEnd } = req.body;

    try {
      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);
      }

      if (planId) {
        const plan = await Plan.findOne({ _id: planId, isActive: true });
        if (!plan) {
          return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
        }
        subscription.planId = planId;

        // Sync tier
        const authHeader = req.headers.authorization || '';
        await syncTierToQuotaService(subscription.orgId, plan.tier, authHeader);
      }

      if (status) subscription.status = status;
      if (interval) subscription.interval = interval;
      if (cancelAtPeriodEnd !== undefined) subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;

      await subscription.save();

      logger.info('Admin updated subscription', { subscriptionId, planId, status });

      return sendSuccess(res, 200, {
        subscription: {
          id: subscription._id.toString(),
          orgId: subscription.orgId,
          planId: subscription.planId,
          status: subscription.status,
          interval: subscription.interval,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          currentPeriodStart: subscription.currentPeriodStart.toISOString(),
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          createdAt: subscription.createdAt.toISOString(),
          updatedAt: subscription.updatedAt.toISOString(),
        },
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
  authenticateToken(AUTH_OPTS) as RequestHandler,
  requireAdmin as RequestHandler,
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

export default router;
