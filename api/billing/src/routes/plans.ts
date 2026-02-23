/**
 * @module routes/plans
 * @description Plan listing routes (public, no auth required).
 *
 * GET /billing/plans              — List all active plans
 * GET /billing/plans/:planId      — Get a single plan by ID
 */

import {
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
} from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import { Plan } from '../models/plan';

const logger = createLogger('billing-plans');
const router: Router = Router();

// ---------------------------------------------------------------------------
// GET /billing/plans — list all active plans
// ---------------------------------------------------------------------------

router.get('/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await Plan.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean();

    const result = plans.map((plan) => ({
      id: plan._id,
      name: plan.name,
      description: plan.description,
      tier: plan.tier,
      prices: plan.prices,
      features: plan.features,
      isDefault: plan.isDefault,
      sortOrder: plan.sortOrder,
    }));

    return sendSuccess(res, 200, { plans: result, total: result.length });
  } catch (error) {
    logger.error('Failed to list plans', { error: errorMessage(error) });
    return sendError(res, 500, 'Failed to list plans', ErrorCode.INTERNAL_ERROR);
  }
});

// ---------------------------------------------------------------------------
// GET /billing/plans/:planId — get a single plan
// ---------------------------------------------------------------------------

router.get('/plans/:planId', async (req: Request, res: Response) => {
  const planId = getParam(req.params, 'planId');
  if (!planId) {
    return sendError(res, 400, 'Plan ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
  }

  try {
    const plan = await Plan.findOne({ _id: planId, isActive: true }).lean();

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

export default router;
