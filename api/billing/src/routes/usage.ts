// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { buildUsageRollupFor } from '../helpers/usage-helpers.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';

const logger = createLogger('billing-usage');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * Cost-and-usage rollup for the active org.
 *
 * Reads the active subscription + plan locally, joins with the quota
 * service's current-period snapshot, and returns a single flat payload
 * the dashboard renders as "what you're paying / what you're using".
 *
 * Pricing is flat-rate today (no metered overages), so `cost.subscriptionCents`
 * just mirrors the plan price for the active interval. The endpoint is
 * structured so a future per-unit pricing add-on can extend `cost` without
 * changing the response shape.
 * @returns Express Router
 */
export function createUsageRoutes(): Router {
  const router: Router = Router();

  router.get('/usage', requireAuth(AUTH_OPTS) as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const authHeader = req.headers.authorization || '';

    // Subscription is optional — free / unsubscribed orgs still get a usage
    // view (against the developer-tier defaults the quota service applies).
    const subscription = await Subscription.findOne({ orgId, status: 'active' }).lean();
    const plan = subscription
      ? await Plan.findById(subscription.planId).lean()
      : null;

    const rollup = await buildUsageRollupFor( orgId,
      authHeader,
      subscription
        ? {
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          interval: subscription.interval,
          planId: subscription.planId,
        }
        : null,
      plan ? { name: plan.name, tier: plan.tier, prices: plan.prices }: null,
    );

    logger.debug('Built usage rollup', {
      orgId,
      hasSubscription: subscription !== null,
      usageKeys: Object.keys(rollup.usage),
    });

    return sendSuccess(res, 200, rollup);
  }));

  return router;
}
