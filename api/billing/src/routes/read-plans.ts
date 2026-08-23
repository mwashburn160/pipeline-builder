// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
  MAX_PAGE_LIMIT,
} from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import { Plan, type PlanDocument } from '../models/plan.js';

const logger = createLogger('billing-plans');

/** Plans rarely change — cache TTL configurable via CACHE_TTL_BILLING_PLANS (default 4 hours). */
const planCache = createCacheService('billing:plans:', parsePositiveInt(process.env.CACHE_TTL_BILLING_PLANS, CACHE_TTL_BILLING_PLANS_SECS));

/**
 * Drop every cached plan projection (the `active` list + any `id:<planId>`
 * entries). Called after the boot-time reconcile in {@link seedPlans} so an
 * env-driven price/feature change surfaces immediately instead of waiting out
 * the multi-hour cache TTL (the cache is Redis-backed and survives restarts).
 */
export async function invalidatePlanCache(): Promise<number> {
  return planCache.invalidatePattern('*');
}

/** The public plan projection shared by the list + single-plan routes. */
function toPlanResponse(plan: PlanDocument) {
  return {
    id: plan._id,
    name: plan.name,
    description: plan.description,
    tier: plan.tier,
    prices: plan.prices,
    features: plan.features,
    isDefault: plan.isDefault,
    sortOrder: plan.sortOrder,
  };
}

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
        // Exclude the `unlimited` tier: it's the billing-DISABLED default and is
        // never purchasable/shown. This route only serves when billing is enabled
        // (disabled → the catch-all 503), so filtering it here means it's never
        // displayed when billing is on — per the tier's contract.
        const plans = await Plan.find({ isActive: true, tier: { $ne: 'unlimited' } })
          .sort({ sortOrder: 1 })
          .limit(MAX_PAGE_LIMIT)
          .lean<PlanDocument[]>();

        return plans.map(toPlanResponse);
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
      // Fetch-then-conditionally-cache rather than getOrSet: getOrSet stores
      // whatever the factory returns, including null. A not-found result is
      // read back as a miss (get treats null as absent), so a null entry never
      // serves a hit yet still occupies an LRU slot — enumerating random ids
      // would evict real plans AND re-hit Mongo every call (cache-busting DB
      // load). Only cache a found plan; a missing plan leaves the cache untouched.
      const cacheKey = `id:${planId}`;
      let plan = await planCache.get<PlanDocument>(cacheKey);
      if (!plan) {
        plan = await Plan.findOne({ _id: planId, isActive: true }).lean<PlanDocument>();
        if (plan) await planCache.set(cacheKey, plan);
      }

      if (!plan) {
        return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
      }

      return sendSuccess(res, 200, {
        plan: toPlanResponse(plan),
      });
    } catch (error) {
      logger.error('Failed to get plan', { error: errorMessage(error), planId });
      return sendError(res, 500, 'Failed to get plan', ErrorCode.INTERNAL_ERROR);
    }
  });

  return router;
}
