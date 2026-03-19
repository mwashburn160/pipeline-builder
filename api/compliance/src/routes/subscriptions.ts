import { sendSuccess, sendBadRequest, ErrorCode, getParam, parsePaginationParams, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { schema, db, buildPublishedRuleCatalogConditions, drizzleCount } from '@mwashburn160/pipeline-core';
import { and, desc, eq, sql, inArray, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { evaluateRules } from '../engine/rule-engine';
import { complianceRuleService, type ComplianceRule } from '../services/compliance-rule-service';
import { subscriptionService } from '../services/subscription-service';

const SubscribeSchema = z.object({
  ruleId: z.string().uuid(),
});

const SetActiveSchema = z.object({
  isActive: z.boolean(),
});

const BulkSetActiveSchema = z.object({
  ruleIds: z.array(z.string().uuid()).min(1).max(100),
  isActive: z.boolean(),
});

const ForkRuleSchema = z.object({
  ruleId: z.string().uuid(),
});

const PreviewSchema = z.object({
  ruleId: z.string().uuid(),
  sampleAttributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Routes for browsing the published rules catalog.
 * Any authenticated org can browse.
 */
export function createPublishedRulesCatalogRoutes(): Router {
  const router = Router();

  // GET / — browse available published rules with subscription status
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const filter = {
      name: req.query.name as string | undefined,
      target: req.query.target as 'plugin' | 'pipeline' | undefined,
      severity: req.query.severity as 'warning' | 'error' | 'critical' | undefined,
      tag: req.query.tag as string | undefined,
    };

    const conditions = buildPublishedRuleCatalogConditions(filter);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceRule)
      .where(whereClause).then(r => drizzleCount(r));

    const rules = await db
      .select()
      .from(schema.complianceRule)
      .where(whereClause)
      .orderBy(desc(schema.complianceRule.priority))
      .limit(limit)
      .offset(offset);

    // Attach subscription status for calling org
    const subscribedIds = new Set(await subscriptionService.getSubscribedRuleIds(orgId));
    const catalog = rules.map(rule => ({
      ...rule,
      subscribed: subscribedIds.has(rule.id),
    }));

    ctx.log('COMPLETED', 'Listed published rules catalog', { count: catalog.length });
    return sendSuccess(res, 200, {
      rules: catalog,
      pagination: { total: countResult?.count ?? 0, limit, offset, hasMore: offset + rules.length < (countResult?.count ?? 0) },
    });
  }));

  return router;
}

/**
 * Routes for managing rule subscriptions.
 * Any authenticated org can subscribe/unsubscribe from published rules.
 */
export function createSubscriptionRoutes(): Router {
  const router = Router();

  // GET / — list this org's active subscriptions with rule details
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const subscriptions = await subscriptionService.findByOrg(orgId);
    const total = subscriptions.length;
    const paginatedSubs = subscriptions.slice(offset, offset + limit);

    // Fetch rule details for paginated subscriptions
    const ruleIds = paginatedSubs.map(s => s.ruleId);
    let rules: ComplianceRule[] = [];
    if (ruleIds.length > 0) {
      rules = await db
        .select()
        .from(schema.complianceRule)
        .where(and(
          inArray(schema.complianceRule.id, ruleIds),
          isNull(schema.complianceRule.deletedAt),
        )) as unknown as ComplianceRule[];
    }

    const rulesById = new Map(rules.map(r => [r.id, r]));
    const result = paginatedSubs.map(sub => ({
      ...sub,
      rule: rulesById.get(sub.ruleId) || null,
    }));

    ctx.log('COMPLETED', 'Listed rule subscriptions', { count: result.length });
    return sendSuccess(res, 200, {
      subscriptions: result,
      pagination: { total, limit, offset, hasMore: offset + paginatedSubs.length < total },
    });
  }));

  // POST /auto-subscribe — subscribe org to all published rules (inactive)
  // Called internally by platform service during org onboarding.
  router.post('/auto-subscribe', withRoute(async ({ res, ctx, orgId, userId }) => {
    const count = await subscriptionService.autoSubscribeToPublished(orgId, userId);
    ctx.log('COMPLETED', 'Auto-subscribed to published rules', { count });
    return sendSuccess(res, 200, { subscribed: count });
  }));

  // PATCH /:ruleId — activate or deactivate a subscribed rule
  router.patch('/:ruleId', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) {
      return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);
    }

    const validation = validateBody(req, SetActiveSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    try {
      const subscription = await subscriptionService.setActive(orgId, ruleId, validation.value.isActive, userId);
      await complianceRuleService.invalidateRulesCache(orgId);

      ctx.log('COMPLETED', `Subscription ${validation.value.isActive ? 'activated' : 'deactivated'}`, { ruleId });
      return sendSuccess(res, 200, { subscription });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return sendBadRequest(res, message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  // POST / — subscribe to a published rule
  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, SubscribeSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { ruleId } = validation.value;

    try {
      const subscription = await subscriptionService.subscribe(orgId, ruleId, userId);
      // No cache invalidation needed — subscriptions start inactive

      ctx.log('COMPLETED', 'Subscribed to published rule (inactive)', { ruleId });
      return sendSuccess(res, 201, { subscription });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found') || message.includes('published')) {
        return sendBadRequest(res, message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  // POST /bulk — bulk activate/deactivate subscriptions (Feature #4)
  router.post('/bulk', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, BulkSetActiveSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { ruleIds, isActive } = validation.value;
    const updated = await subscriptionService.bulkSetActive(orgId, ruleIds, isActive, userId);
    await complianceRuleService.invalidateRulesCache(orgId);

    ctx.log('COMPLETED', `Bulk ${isActive ? 'activated' : 'deactivated'} subscriptions`, { requested: ruleIds.length, updated });
    return sendSuccess(res, 200, { requested: ruleIds.length, updated });
  }));

  // POST /fork — fork a published rule into org scope (Feature #1)
  router.post('/fork', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ForkRuleSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    try {
      const rule = await complianceRuleService.forkRule(validation.value.ruleId, orgId, userId);
      ctx.log('COMPLETED', 'Forked published rule', { sourceRuleId: validation.value.ruleId, newRuleId: rule.id });
      return sendSuccess(res, 201, { rule });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return sendBadRequest(res, message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  // GET /enforced — merged view of all enforced rules (org + active subscriptions) (Feature #6)
  router.get('/enforced', withRoute(async ({ req, res, ctx, orgId }) => {
    const target = req.query.target as 'plugin' | 'pipeline' | undefined;
    const rules = await complianceRuleService.findAllEnforced(orgId, target);

    ctx.log('COMPLETED', 'Listed all enforced rules', { count: rules.length });
    return sendSuccess(res, 200, { rules, total: rules.length });
  }));

  // POST /preview — dry-run preview of how a rule would affect existing entities (Feature #10)
  router.post('/preview', withRoute(async ({ req, res, ctx }) => {
    const validation = validateBody(req, PreviewSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { ruleId, sampleAttributes } = validation.value;

    // Fetch the rule
    const [rule] = await db
      .select()
      .from(schema.complianceRule)
      .where(and(
        eq(schema.complianceRule.id, ruleId),
        isNull(schema.complianceRule.deletedAt),
      ));

    if (!rule) return sendBadRequest(res, 'Rule not found', ErrorCode.VALIDATION_ERROR);

    // If sample attributes provided, evaluate against them
    if (sampleAttributes) {
      const result = evaluateRules([rule as unknown as Parameters<typeof evaluateRules>[0][0]], sampleAttributes, []);
      ctx.log('COMPLETED', 'Subscription activation preview', { ruleId, blocked: result.blocked });
      return sendSuccess(res, 200, { preview: result });
    }

    // Otherwise return rule details for the org to review
    ctx.log('COMPLETED', 'Subscription rule preview', { ruleId });
    return sendSuccess(res, 200, { rule });
  }));

  // POST /:ruleId/pin — pin subscription to current rule version (Feature #5)
  router.post('/:ruleId/pin', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);

    try {
      const subscription = await subscriptionService.pinVersion(orgId, ruleId, userId);
      ctx.log('COMPLETED', 'Pinned subscription version', { ruleId });
      return sendSuccess(res, 200, { subscription });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return sendBadRequest(res, message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  // DELETE /:ruleId/pin — unpin subscription (use latest rule version) (Feature #5)
  router.delete('/:ruleId/pin', withRoute(async ({ req, res, ctx, orgId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);

    try {
      const subscription = await subscriptionService.unpinVersion(orgId, ruleId);
      await complianceRuleService.invalidateRulesCache(orgId);
      ctx.log('COMPLETED', 'Unpinned subscription version', { ruleId });
      return sendSuccess(res, 200, { subscription });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return sendBadRequest(res, message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  // DELETE /:ruleId — unsubscribe from a published rule
  router.delete('/:ruleId', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) {
      return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);
    }

    try {
      await subscriptionService.unsubscribe(orgId, ruleId, userId);
      await complianceRuleService.invalidateRulesCache(orgId);

      ctx.log('COMPLETED', 'Unsubscribed from published rule', { ruleId });
      return sendSuccess(res, 200, { message: 'Unsubscribed successfully' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return sendBadRequest(res, message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  return router;
}
