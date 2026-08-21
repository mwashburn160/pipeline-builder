// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendPaginatedNested,
  sendBadRequest,
  sendError,
  ErrorCode,
  errorMessage,
  getParam,
  parsePaginationParams,
  validateBody,
  requirePermission,
  userHasPermission,
  requireServicePrincipal,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { evaluateRules } from '../engine/rule-engine.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';
import { emitComplianceAudit, getAuditClient } from '../services/remote-audit-client.js';
import {
  subscriptionService,
  CS_RULE_NOT_FOUND,
  CS_SUBSCRIPTION_NOT_FOUND,
  CS_NOT_PUBLISHED,
  CS_SYSTEM_ORG,
} from '../services/subscription-service.js';

/**
 * Maps typed subscription-service error codes (`CS_*`) to HTTP responses.
 * Keyed on the exact thrown code — a reworded message can never silently
 * degrade a 4xx into a 500. The raw `CS_*` code is never surfaced to the
 * client; only the mapped message is. Unmapped errors rethrow (→ 500).
 */
const SUB_ERROR_MAP: Record<string, { status: number; message: string; code: ErrorCode }> = {
  [CS_RULE_NOT_FOUND]: { status: 400, message: 'Rule not found', code: ErrorCode.VALIDATION_ERROR },
  [CS_SUBSCRIPTION_NOT_FOUND]: { status: 400, message: 'Subscription not found', code: ErrorCode.VALIDATION_ERROR },
  [CS_NOT_PUBLISHED]: { status: 400, message: 'Only published rules can be subscribed to', code: ErrorCode.VALIDATION_ERROR },
  [CS_SYSTEM_ORG]: { status: 403, message: 'System org cannot manage rule subscriptions', code: ErrorCode.INSUFFICIENT_PERMISSIONS },
};

/**
 * Translate a caught subscription-service error into an HTTP response.
 * Returns `true` when the error was mapped (response already sent); returns
 * `false` when the caller should rethrow (unmapped → propagates to 500).
 */
function handleSubError(res: Response, err: unknown): boolean {
  const mapped = SUB_ERROR_MAP[errorMessage(err)];
  if (!mapped) return false;
  sendError(res, mapped.status, mapped.message, mapped.code);
  return true;
}

/**
 * Best-effort `authz.denied` audit for the two INLINE `compliance:write`
 * deactivate denials (PATCH /:ruleId, POST /bulk). Gate-based denials
 * (`requirePermission`) already record this via the shared middleware; these
 * inline branches send their own 403, so without this they'd be invisible to a
 * reviewer. Fire-and-forget — `record` never throws and is not awaited — so it
 * can never delay or fail the 403 it precedes.
 */
function auditComplianceWriteDenied(req: Request): void {
  getAuditClient().record({
    action: 'authz.denied',
    actorId: req.user?.sub ?? 'system',
    actorEmail: req.user?.email,
    orgId: req.user?.organizationId,
    outcome: 'failure',
    details: { method: req.method, path: req.originalUrl ?? req.url, required: 'compliance:write' },
  }, 'compliance');
}

/**
 * Whether the caller's JWT carries a plan feature. Mirrors api-core's
 * `requireFeature` middleware (sysadmins bypass; otherwise the `features[]`
 * claim must contain the flag) — inlined here because the gate is data-driven
 * (which feature is required depends on the target rule's `set:` tag, only known
 * after the rule is looked up), so a static route-level `requireFeature` mount
 * can't express it.
 */
function callerHasFeature(req: Request, feature: string): boolean {
  if (req.user?.isSuperAdmin === true) return true;
  return req.user?.features?.includes(feature) === true;
}

/**
 * Resolve which entitlement feature a published rule's `set:` tag requires, or
 * `null` for a baseline/un-tagged published rule (which stays open). Advanced is
 * checked first so a rule tagged both resolves to the higher entitlement.
 * Accepts the raw jsonb `tags` value (unknown at the type level) so callers can
 * pass a rule's `tags` column without a per-site cast.
 */
function requiredFeatureForTags(tags: unknown): 'compliance_standard' | 'compliance_advanced' | null {
  const t = Array.isArray(tags) ? (tags as string[]) : [];
  if (t.includes('set:advanced')) return 'compliance_advanced';
  if (t.includes('set:standard')) return 'compliance_standard';
  return null;
}

/** Best-effort `authz.denied` audit for a curated-set subscribe blocked by a
 *  missing plan feature — the entitlement counterpart of the write-denied audit
 *  above. Fire-and-forget. */
function auditFeatureDenied(req: Request, orgId: string, ruleId: string, feature: string): void {
  getAuditClient().record({
    action: 'authz.denied',
    actorId: req.user?.sub ?? 'system',
    actorEmail: req.user?.email,
    orgId,
    outcome: 'failure',
    details: { method: req.method, path: req.originalUrl ?? req.url, required: `feature:${feature}`, ruleId },
  }, 'compliance');
}

/**
 * The curated-set entitlement paywall applied identically by every enforcement-
 * path route (subscribe / activate / bulk-activate / clone / impact-preview):
 * when `requiredFeature` is set and the caller's JWT lacks it, record the denial
 * audit, send the canonical 403, and return `true` (caller must stop). Returns
 * `false` for a baseline/un-tagged rule (`requiredFeature === null`) or an
 * entitled caller. `requiredFeature` is passed in (not re-derived) because the
 * subscribe route reuses it after the gate to tag its audit event.
 */
function denyIfUnentitled(
  req: Request,
  res: Response,
  orgId: string,
  ruleId: string,
  requiredFeature: 'compliance_standard' | 'compliance_advanced' | null,
): boolean {
  if (requiredFeature && !callerHasFeature(req, requiredFeature)) {
    auditFeatureDenied(req, orgId, ruleId, requiredFeature);
    sendError(res, 403, `This feature requires a higher plan (${requiredFeature})`, ErrorCode.INSUFFICIENT_PERMISSIONS);
    return true;
  }
  return false;
}

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
    // Pagination is pushed into SQL (LIMIT/OFFSET + a COUNT) instead of loading
    // the whole subscription set and slicing in JS.
    const { subscriptions, total } = await subscriptionService.findByOrg(orgId, limit, offset);

    const ruleIds = subscriptions.map(s => s.ruleId);
    const rules = await complianceRuleService.findManyByIds(ruleIds);
    const rulesById = new Map(rules.map(r => [r.id, r]));

    const result = subscriptions.map(sub => ({
      ...sub,
      rule: rulesById.get(sub.ruleId) || null,
    }));

    ctx.log('COMPLETED', 'Listed rule subscriptions', { count: result.length });
    return sendPaginatedNested(res, 'subscriptions', result, {
      total, limit, offset, hasMore: offset + subscriptions.length < total,
    });
  }));

  // POST /auto-subscribe — subscribe org to all published rules (inactive).
  // Internal-only: the platform service calls this during org onboarding with a
  // service JWT (`getServiceAuthHeader`). `requireServicePrincipal` rejects any
  // interactive user token so a member can't bulk-mint subscriptions.
  router.post('/auto-subscribe', requireServicePrincipal, withRoute(async ({ res, ctx, orgId, userId }) => {
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

    // Activating (opt-in) stays member-level, but DEACTIVATING an active rule
    // weakens the org's enforced compliance posture at upload/validate time —
    // that's governance, not opt-in — so it requires `compliance:write` (same
    // gate as rule authoring / exemption approval / clone). See the mount in
    // index.ts: subscriptions run at member level, so this is enforced inline.
    if (!validation.value.isActive && !userHasPermission(req, 'compliance:write')) {
      auditComplianceWriteDenied(req);
      return sendError(res, 403, 'Missing required permission: compliance:write', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Entitlement gate: ACTIVATING a curated-library rule (tagged `set:*`) is a
    // path to enforcement — same paywall as POST /subscriptions. Deactivating
    // stays open (weakens posture, gated by compliance:write above). A rule that
    // isn't a published set-tagged rule (miss / baseline) falls through ungated.
    if (validation.value.isActive) {
      const rule = await complianceRuleService.findPublishedById(ruleId);
      if (denyIfUnentitled(req, res, orgId, ruleId, requiredFeatureForTags(rule?.tags))) return;
    }

    try {
      const subscription = await subscriptionService.setActive(orgId, ruleId, validation.value.isActive, userId);
      ctx.log('COMPLETED', `Subscription ${validation.value.isActive ? 'activated' : 'deactivated'}`, { ruleId });

      // Best-effort attributed audit — toggling an enforced rule's active
      // state changes the org's compliance posture at upload/validate time.
      emitComplianceAudit({
        action: 'compliance.rule.toggle',
        actorId: req.user?.sub ?? userId ?? 'system',
        orgId,
        targetType: 'rule',
        targetId: ruleId,
        details: { isActive: validation.value.isActive },
      });

      return sendSuccess(res, 200, { subscription });
    } catch (err) {
      if (handleSubError(res, err)) return;
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

    // Entitlement gate: subscribing to a curated-library rule (tagged
    // `set:standard` / `set:advanced`) requires the matching plan feature on the
    // caller's JWT. Baseline/un-tagged published rules stay open. Authoring stays
    // free — only the curated libraries are gated. The rule is looked up here
    // (before subscribe) to read its `set:` tag; a miss falls through to
    // `subscribe`, which returns the canonical CS_RULE_NOT_FOUND response.
    const publishedRule = await complianceRuleService.findPublishedById(ruleId);
    const requiredFeature = requiredFeatureForTags(publishedRule?.tags);
    if (denyIfUnentitled(req, res, orgId, ruleId, requiredFeature)) return;

    try {
      const subscription = await subscriptionService.subscribe(orgId, ruleId, userId);
      // No cache invalidation needed — subscriptions start inactive
      ctx.log('COMPLETED', 'Subscribed to published rule (inactive)', { ruleId });

      // Audit curated-set subscribes (the entitlement-relevant ones). Reuse
      // `compliance.rule.toggle` — the closest existing remote-audit action for a
      // subscription-posture change — with the set + source in `details`.
      if (requiredFeature) {
        emitComplianceAudit({
          action: 'compliance.rule.toggle',
          actorId: req.user?.sub ?? userId ?? 'system',
          orgId,
          targetType: 'rule',
          targetId: ruleId,
          details: { subscribed: true, set: requiredFeature === 'compliance_advanced' ? 'advanced' : 'standard' },
        });
      }
      return sendSuccess(res, 201, { subscription });
    } catch (err) {
      if (handleSubError(res, err)) return;
      throw err;
    }
  }));

  // POST /bulk — bulk activate/deactivate subscriptions
  router.post('/bulk', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, BulkSetActiveSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { ruleIds, isActive } = validation.value;
    // Bulk deactivate carries the same governance weight as the single-rule
    // PATCH above — reject the whole batch unless the caller holds
    // `compliance:write`. Bulk activate stays member-level (opt-in).
    if (!isActive && !userHasPermission(req, 'compliance:write')) {
      auditComplianceWriteDenied(req);
      return sendError(res, 403, 'Missing required permission: compliance:write', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Entitlement gate on bulk ACTIVATE: reject the whole batch if it would
    // activate ANY curated-library rule (`set:*`) the caller isn't entitled to —
    // the same paywall as the single-rule PATCH and POST /subscriptions. Look up
    // the batch's published rules once (baseline/org/missing rules carry no
    // set tag and don't gate). Bulk deactivate stays open (governance-gated).
    if (isActive) {
      const rules = await complianceRuleService.findManyByIds(ruleIds);
      for (const rule of rules) {
        if (denyIfUnentitled(req, res, orgId, rule.id, requiredFeatureForTags(rule.tags))) return;
      }
    }

    const affectedIds = await subscriptionService.bulkSetActive(orgId, ruleIds, isActive, userId);
    const updated = affectedIds.length;
    ctx.log('COMPLETED', `Bulk ${isActive ? 'activated' : 'deactivated'} subscriptions`, { requested: ruleIds.length, updated });

    // Best-effort attributed audit — one event per rule ACTUALLY toggled (a row
    // that matched and changed), not per requested id, so posture changes aren't
    // logged for rules that weren't subscribed or didn't change. Mirrors the
    // per-row iteration of the pipeline bulk handlers and keeps targetId = rule
    // id consistent with the single-rule PATCH above.
    for (const ruleId of affectedIds) {
      emitComplianceAudit({
        action: 'compliance.rule.toggle',
        actorId: req.user?.sub ?? userId ?? 'system',
        orgId,
        targetType: 'rule',
        targetId: ruleId,
        details: { isActive },
      });
    }

    return sendSuccess(res, 200, { requested: ruleIds.length, updated });
  }));

  // POST /clone — clone a published rule into org scope (one-shot copy, no
  // upstream link). Previously named `/fork`; "fork" carried git connotations
  // (track upstream for merge) we never delivered.
  // Cloning authors a new org-scoped rule (same write as POST /compliance/rules),
  // so it requires `compliance:write`. Subscribe/toggle/delete below stay at
  // member level — those are per-org opt-in, not rule authoring.
  router.post('/clone', requirePermission('compliance:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, SubscribeSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    // Entitlement gate: cloning copies a curated-library rule's enforceable body
    // into the org — a path to enforcement, so it carries the same paywall as
    // subscribing. Gate on the SOURCE published rule's `set:` tag (compliance:
    // write above authorizes AUTHORING; it does not grant the curated content).
    const source = await complianceRuleService.findPublishedById(validation.value.ruleId);
    if (denyIfUnentitled(req, res, orgId, validation.value.ruleId, requiredFeatureForTags(source?.tags))) return;

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

  // GET /enforced — merged view of all enforced rules (org + active subscriptions)
  router.get('/enforced', withRoute(async ({ req, res, ctx, orgId }) => {
    const target = req.query.target as 'plugin' | 'pipeline' | undefined;
    // Include the parent's `propagateToChildren` rules for a team, matching what
    // actually blocks at upload/validate time (validate.ts reads the same claim).
    const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
    const rules = await complianceRuleService.findAllEnforced(orgId, target, parentOrgId);

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

    // Entitlement gate: running a curated-library rule against the org's live
    // entities is a preview of the paid content — gate it the same as subscribe
    // so a non-entitled org can't dry-run the paywalled ruleset. Baseline/
    // un-tagged published rules stay open.
    if (denyIfUnentitled(req, res, orgId, rule.id, requiredFeatureForTags(rule.tags))) return;

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

  // POST /preview — dry-run preview of how a rule would affect existing entities
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

  // POST /:ruleId/pin — pin subscription to current rule version
  router.post('/:ruleId/pin', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);

    try {
      const subscription = await subscriptionService.pinVersion(orgId, ruleId, userId);
      ctx.log('COMPLETED', 'Pinned subscription version', { ruleId });
      return sendSuccess(res, 200, { subscription });
    } catch (err) {
      if (handleSubError(res, err)) return;
      throw err;
    }
  }));

  // DELETE /:ruleId/pin — unpin subscription (use latest rule version)
  router.delete('/:ruleId/pin', withRoute(async ({ req, res, ctx, orgId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);

    try {
      const subscription = await subscriptionService.unpinVersion(orgId, ruleId);
      ctx.log('COMPLETED', 'Unpinned subscription version', { ruleId });
      return sendSuccess(res, 200, { subscription });
    } catch (err) {
      if (handleSubError(res, err)) return;
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
      ctx.log('COMPLETED', 'Unsubscribed from published rule', { ruleId });
      return sendSuccess(res, 200, { message: 'Unsubscribed successfully' });
    } catch (err) {
      if (handleSubError(res, err)) return;
      throw err;
    }
  }));

  return router;
}
