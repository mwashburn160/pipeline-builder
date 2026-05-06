// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendPaginatedNested,
  sendBadRequest,
  ErrorCode,
  errorMessage,
  getParam,
  parsePaginationParams,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { evaluateRules } from '../engine/rule-engine';
import { complianceRuleService } from '../services/compliance-rule-service';
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

    const { rules, total } = await complianceRuleService.listPublishedCatalog(filter, limit, offset);

    // Attach subscription status for calling org
    const subscribedIds = new Set(await subscriptionService.getSubscribedRuleIds(orgId));
    const catalog = rules.map(rule => ({ ...rule, subscribed: subscribedIds.has(rule.id) }));

    ctx.log('COMPLETED', 'Listed published rules catalog', { count: catalog.length });
    return sendPaginatedNested(res, 'rules', catalog, {
      total, limit, offset, hasMore: offset + rules.length < total,
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

    const ruleIds = paginatedSubs.map(s => s.ruleId);
    const rules = await complianceRuleService.findManyByIds(ruleIds);
    const rulesById = new Map(rules.map(r => [r.id, r]));

    const result = paginatedSubs.map(sub => ({
      ...sub,
      rule: rulesById.get(sub.ruleId) || null,
    }));

    ctx.log('COMPLETED', 'Listed rule subscriptions', { count: result.length });
    return sendPaginatedNested(res, 'subscriptions', result, {
      total, limit, offset, hasMore: offset + paginatedSubs.length < total,
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
      const message = errorMessage(err);
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
      const message = errorMessage(err);
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

  // POST /clone — clone a published rule into org scope (one-shot copy, no
  // upstream link). Previously named `/fork`; "fork" carried git connotations
  // (track upstream for merge) we never delivered.
  router.post('/clone', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ForkRuleSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    try {
      const rule = await complianceRuleService.cloneRule(validation.value.ruleId, orgId, userId);
      ctx.log('COMPLETED', 'Cloned published rule', { sourceRuleId: validation.value.ruleId, newRuleId: rule.id });
      return sendSuccess(res, 201, { rule });
    } catch (err) {
      const message = errorMessage(err);
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

  // POST /preview/impact — evaluate a published-or-org rule against the caller's
  // existing plugins/pipelines (whichever target the rule applies to) WITHOUT
  // subscribing or persisting. Returns aggregate counts + up to 10 samples of
  // failing entities so the org admin can see "this rule would fail 12/80
  // entities right now" before they enable it.
  //
  // Distinct from POST /preview, which evaluates against caller-supplied
  // sample attributes — that's "what if X looked like this," whereas this is
  // "what would happen to my existing X."
  router.post('/preview/impact', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, SubscribeSchema); // shape: { ruleId: uuid }
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    const rule = await complianceRuleService.findPublishedById(validation.value.ruleId);
    if (!rule) return sendBadRequest(res, 'Rule not found', ErrorCode.VALIDATION_ERROR);

    const target = rule.target as 'plugin' | 'pipeline';
    const SAMPLE_CAP = 10;
    const ENTITY_FETCH_CAP = 1000;

    const entities = await complianceRuleService.findOrgEntitiesForTarget(target, orgId, ENTITY_FETCH_CAP);

    let wouldPass = 0;
    let wouldFail = 0;
    const samples: Array<{ entityType: string; entityId: string; entityName: string | null; messages: string[] }> = [];

    for (const entity of entities) {
      const result = evaluateRules([rule as unknown as Parameters<typeof evaluateRules>[0][0]], entity.raw, []);
      if (result.blocked || result.warnings.length > 0) {
        wouldFail++;
        if (samples.length < SAMPLE_CAP) {
          const msgs = [...result.violations, ...result.warnings].map(v => v.message);
          samples.push({ entityType: target, entityId: entity.id, entityName: entity.name, messages: msgs });
        }
      } else {
        wouldPass++;
      }
    }

    ctx.log('COMPLETED', 'Rule impact preview', { ruleId: rule.id, target, total: entities.length, wouldFail });
    return sendSuccess(res, 200, {
      ruleId: rule.id,
      ruleName: rule.name,
      target,
      total: entities.length,
      wouldPass,
      wouldFail,
      samples,
    });
  }));

  // POST /preview — dry-run preview of how a rule would affect existing entities (Feature #10)
  router.post('/preview', withRoute(async ({ req, res, ctx }) => {
    const validation = validateBody(req, PreviewSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { ruleId, sampleAttributes } = validation.value;

    const rule = await complianceRuleService.findPublishedById(ruleId);
    if (!rule) return sendBadRequest(res, 'Rule not found', ErrorCode.VALIDATION_ERROR);

    if (sampleAttributes) {
      const result = evaluateRules([rule as unknown as Parameters<typeof evaluateRules>[0][0]], sampleAttributes, []);
      ctx.log('COMPLETED', 'Subscription activation preview', { ruleId, blocked: result.blocked });
      return sendSuccess(res, 200, { preview: result });
    }

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
      const message = errorMessage(err);
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
      const message = errorMessage(err);
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
      const message = errorMessage(err);
      if (message.includes('not found')) {
        return sendBadRequest(res, message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  return router;
}
