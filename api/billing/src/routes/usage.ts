// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth, requirePermission, sendSuccess, sendError, ErrorCode, errorMessage, parseOptionalDate } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { resolveAccountRootOrgId } from '../helpers/root-org-guard.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from '../helpers/subscription-status.js';
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

  router.get('/usage', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const authHeader = req.headers.authorization || '';

    // Optional caller-supplied display window (editable period start/end in the
    // UI). Reframes the DISPLAYED period + day math only — the usage bars remain
    // the live current-period quota snapshot. Malformed → 400 (never silently
    // ignored, so a bad date can't masquerade as the default window).
    const periodStart = parseOptionalDate(req.query.periodStart);
    const periodEnd = parseOptionalDate(req.query.periodEnd);
    if (periodStart === null || periodEnd === null) {
      return sendError(res, 400, 'periodStart/periodEnd must be ISO dates', ErrorCode.VALIDATION_ERROR);
    }
    const periodOverride = (periodStart || periodEnd)
      ? { start: periodStart ?? undefined, end: periodEnd ?? undefined }
      : null;

    // Subscription is optional — free / unsubscribed orgs still get a usage
    // view (against the developer-tier defaults the quota service applies).
    // Match the manageable (non-terminal) set — active / trialing / past_due —
    // like every sibling route: a trialing or past_due org is paying/dunning on
    // a real plan, so resolving only status:'active' wrongly showed them the
    // developer defaults ($0 cost, wrong window).
    //
    // The subscription lives on the ACCOUNT root only, while a team member acts
    // with the team's org id — so resolve the root first, or every team caller
    // reads no subscription and sees $0 cost. FAIL-CLOSED like the
    // support-incident routes: a hierarchy that can't be proven answers 503
    // rather than silently showing the team developer defaults.
    let accountOrgId: string;
    try {
      accountOrgId = await resolveAccountRootOrgId(orgId);
    } catch (err) {
      logger.error('Usage account lookup failed', { orgId, error: errorMessage(err) });
      return sendError(res, 503, 'Could not resolve the organization\'s account; try again', ErrorCode.SERVICE_UNAVAILABLE);
    }
    const subscription = await Subscription.findOne({
      orgId: accountOrgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
    }).lean();
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
      periodOverride,
    );

    logger.debug('Built usage rollup', {
      orgId,
      accountOrgId,
      hasSubscription: subscription !== null,
      usageKeys: Object.keys(rollup.usage),
    });

    return sendSuccess(res, 200, rollup);
  }));

  return router;
}
