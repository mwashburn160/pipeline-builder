import {
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
  createCacheService,
  parsePositiveInt,
  CACHE_TTL_BILLING_PLANS_SECS,
} from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import { Plan } from '../models/plan';

const logger = createLogger('billing-plans');

/** Plans rarely change — cache TTL configurable via CACHE_TTL_BILLING_PLANS (default 4 hours). */
/** Parse a positive integer from an env var, falling back to the default on invalid input. */

const planCache = createCacheService('billing:plans:', parsePositiveInt(process.env.CACHE_TTL_BILLING_PLANS, CACHE_TTL_BILLING_PLANS_SECS));

/**
 * Create the public plan-listing router (no auth required).
 *
 * Registers:
 * - GET /plans       -- list all active plans
 * - GET /plans/:planId -- get a single plan by ID
 * @returns Express Router
 */
export function createReadPlanRoutes(): Router {
  const router: Router = Router();

  // GET /billing/plans — list all active plans (cached — plans rarely change)

  router.get('/plans', async (_req: Request, res: Response) => {
    try {
      const result = await planCache.getOrSet('active', async () => {
        const plans = await Plan.find({ isActive: true })
          .sort({ sortOrder: 1 })
          .lean();

        return plans.map((plan) => ({
          id: plan._id,
          name: plan.name,
          description: plan.description,
          tier: plan.tier,
          prices: plan.prices,
          features: plan.features,
          isDefault: plan.isDefault,
          sortOrder: plan.sortOrder,
        }));
      });

      return sendSuccess(res, 200, { plans: result, total: result.length });
    } catch (error) {
      logger.error('Failed to list plans', { error: errorMessage(error) });
      return sendError(res, 500, 'Failed to list plans', ErrorCode.INTERNAL_ERROR);
    }
  });

  // GET /billing/plans/:planId — get a single plan

  router.get('/plans/:planId', async (req: Request, res: Response) => {
    const planId = getParam(req.params, 'planId');
    if (!planId) {
      return sendError(res, 400, 'Plan ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
    }

    try {
      const plan = await planCache.getOrSet(`id:${planId}`, () =>
        Plan.findOne({ _id: planId, isActive: true }).lean(),
      );

      if (!plan) {
        return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
      }

      return sendSuccess(res, 200, {
        plan: {
          id: plan._id,
          name: plan.name,
          description: plan.description,
          tier: plan.tier,
          prices: plan.prices,
          features: plan.features,
          isDefault: plan.isDefault,
          sortOrder: plan.sortOrder,
        },
      });
    } catch (error) {
      logger.error('Failed to get plan', { error: errorMessage(error), planId });
      return sendError(res, 500, 'Failed to get plan', ErrorCode.INTERNAL_ERROR);
    }
  });

  return router;
}
