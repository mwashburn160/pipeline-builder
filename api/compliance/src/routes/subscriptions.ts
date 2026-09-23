// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendPaginatedNested,
  sendBadRequest,
  ErrorCode,
  getParam,
  parsePaginationParams,
  validateBody,
  audited,
  requireFeature,
  requirePermission,
  requireInternalService,
  actorId,
  complianceFeatureForTags,
  type FeatureFlag,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { evaluateRules } from '../engine/rule-engine.js';
import { withInheritedSource } from '../helpers/inherited-source.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';
import { subscriptionService } from '../services/subscription-service.js';

/** Compliance-write gate, built once. */
const requireComplianceWrite = requirePermission('compliance:write');

/**
 * Compliance-READ gate, built once. The subscription surface has two tiers: the
 * per-org OPT-IN actions (browse, subscribe, activate, preview) sit at member
 * level and require only `compliance:read`, while the posture-WEAKENING or
 * authoring ones (deactivate, unsubscribe, clone, pin) require
 * `compliance:write`. `compliance:read` is the floor for all of them — before
 * it, a principal holding no compliance capability at all could mint
 * subscriptions and activate enforced rules.
 */
const requireComplianceRead = requirePermission('compliance:read');

/**
 * Run an api-core authorization gate (`requirePermission` / `requireFeature`)
 * INLINE, for the data-driven checks whose requirement is only known inside the
 * handler (deactivate vs activate; a rule's `set:` tag). Returns true when the
 * gate passed. On denial the gate itself has already sent the canonical 403 and
 * recorded the shared `authz.denied` audit (query string stripped) — the caller
 * must just stop. Both gates are synchronous (call `next` or send), so the
 * result is known on return.
 */
function passesGate(
  gate: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
  res: Response,
): boolean {
  let passed = false;
  gate(req, res, () => { passed = true; });
  return passed;
}

/**
 * The curated-set entitlement paywall applied identically by every enforcement-
 * path route (subscribe / activate / bulk-activate / clone / impact-preview):
 * when `requiredFeature` is set, run api-core's `requireFeature` gate (sysadmin
 * bypass; 403 + `authz.denied` audit on denial) and return `true` when it denied
 * (caller must stop). Returns `false` for a baseline/un-tagged rule
 * (`requiredFeature === null`) or an entitled caller. `requiredFeature` is passed
 * in (not re-derived) because the subscribe route reuses it after the gate to
 * tag its audit event.
 */
function denyIfUnentitled(
  req: Request,
  res: Response,
  requiredFeature: FeatureFlag | null,
): boolean {
  return requiredFeature !== null && !passesGate(requireFeature(requiredFeature), req, res);
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
  router.get('/', requireComplianceRead, withRoute(async ({ req, res, ctx, orgId }) => {
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
      total, limit, offset,
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
  router.get('/', requireComplianceRead, withRoute(async ({ req, res, ctx, orgId }) => {
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
      total, limit, offset,
    });
  }));

  // POST /auto-subscribe — subscribe org to all published rules (inactive).
  // Internal-only: the platform service calls this during org onboarding with a
  // service JWT (`getServiceAuthHeader`). `requireInternalService` rejects any
  // interactive user token — so a member can't bulk-mint subscriptions — and
  // any service other than `platform`.
  router.post('/auto-subscribe', requireInternalService({ callers: ['platform'] }), withRoute(async ({ res, ctx, orgId, userId }) => {
    const count = await subscriptionService.autoSubscribeToPublished(orgId, userId);
    ctx.log('COMPLETED', 'Auto-subscribed to published rules', { count });
    return sendSuccess(res, 200, { subscribed: count });
  }));

  // PATCH /:ruleId — activate or deactivate a subscribed rule
  router.patch('/:ruleId', requireComplianceRead, audited('compliance.rule.toggle'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
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
    if (!validation.value.isActive && !passesGate(requireComplianceWrite, req, res)) return;

    // Entitlement gate: ACTIVATING a curated-library rule (tagged `set:*`) is a
    // path to enforcement — same paywall as POST /subscriptions. Deactivating
    // stays open (weakens posture, gated by compliance:write above). A rule that
    // isn't a published set-tagged rule (miss / baseline) falls through ungated.
    if (validation.value.isActive) {
      const rule = await complianceRuleService.findPublishedById(ruleId);
      if (denyIfUnentitled(req, res, complianceFeatureForTags(rule?.tags))) return;
    }

    const subscription = await subscriptionService.setActive(orgId, ruleId, validation.value.isActive, userId);
    ctx.log('COMPLETED', `Subscription ${validation.value.isActive ? 'activated' : 'deactivated'}`, { ruleId });

    // Best-effort attributed audit — toggling an enforced rule's active
    // state changes the org's compliance posture at upload/validate time.
    recordAudit({
      action: 'compliance.rule.toggle',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'rule',
      targetId: ruleId,
      details: { isActive: validation.value.isActive },
    });

    return sendSuccess(res, 200, { subscription });
  }));

  // POST / — subscribe to a published rule
  router.post('/', requireComplianceRead, audited('compliance.rule.toggle'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
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
    // `subscribe`, which answers with the canonical rule-not-found error.
    const publishedRule = await complianceRuleService.findPublishedById(ruleId);
    const requiredFeature = complianceFeatureForTags(publishedRule?.tags);
    if (denyIfUnentitled(req, res, requiredFeature)) return;

    const subscription = await subscriptionService.subscribe(orgId, ruleId, userId);
    // No cache invalidation needed — subscriptions start inactive
    ctx.log('COMPLETED', 'Subscribed to published rule (inactive)', { ruleId });

    // Audit curated-set subscribes (the entitlement-relevant ones). Reuse
    // `compliance.rule.toggle` — the closest existing remote-audit action for a
    // subscription-posture change — with the set + source in `details`.
    if (requiredFeature) {
      recordAudit({
        action: 'compliance.rule.toggle',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'rule',
        targetId: ruleId,
        details: { subscribed: true, set: requiredFeature === 'compliance_advanced' ? 'advanced' : 'standard' },
      });
    }
    return sendSuccess(res, 201, { subscription });
  }));

  // POST /bulk — bulk activate/deactivate subscriptions
  router.post('/bulk', requireComplianceRead, audited('compliance.rule.toggle'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, BulkSetActiveSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { ruleIds, isActive } = validation.value;
    // Bulk deactivate carries the same governance weight as the single-rule
    // PATCH above — reject the whole batch unless the caller holds
    // `compliance:write`. Bulk activate stays member-level (opt-in).
    if (!isActive && !passesGate(requireComplianceWrite, req, res)) return;

    // Entitlement gate on bulk ACTIVATE: reject the whole batch if it would
    // activate ANY curated-library rule (`set:*`) the caller isn't entitled to —
    // the same paywall as the single-rule PATCH and POST /subscriptions. Look up
    // the batch's published rules once (baseline/org/missing rules carry no
    // set tag and don't gate). Bulk deactivate stays open (governance-gated).
    if (isActive) {
      const rules = await complianceRuleService.findManyByIds(ruleIds);
      for (const rule of rules) {
        if (denyIfUnentitled(req, res, complianceFeatureForTags(rule.tags))) return;
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
      recordAudit({
        action: 'compliance.rule.toggle',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'rule',
        targetId: ruleId,
        details: { isActive },
      });
    }

    return sendSuccess(res, 200, { requested: ruleIds.length, updated });
  }));

  // POST /clone — clone a published rule into org scope (one-shot copy, no
  // upstream link). Named `clone`, not `fork`: "fork" carries git connotations
  // (track upstream for merge) this does not deliver.
  // Cloning authors a new org-scoped rule (same write as POST /compliance/rules),
  // so it requires `compliance:write`. Subscribe/toggle/delete below stay at
  // member level — those are per-org opt-in, not rule authoring.
  router.post('/clone', requireComplianceWrite, audited('compliance.rule.create'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, SubscribeSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    // Entitlement gate: cloning copies a curated-library rule's enforceable body
    // into the org — a path to enforcement, so it carries the same paywall as
    // subscribing. Gate on the SOURCE published rule's `set:` tag (compliance:
    // write above authorizes AUTHORING; it does not grant the curated content).
    const source = await complianceRuleService.findPublishedById(validation.value.ruleId);
    if (denyIfUnentitled(req, res, complianceFeatureForTags(source?.tags))) return;

    // An unknown/unpublished source raises `ValidationError`, which `withRoute`
    // answers as a 400 — no try/catch here.
    const rule = await complianceRuleService.cloneRule(validation.value.ruleId, orgId, userId);
    ctx.log('COMPLETED', 'Cloned published rule', { sourceRuleId: validation.value.ruleId, newRuleId: rule.id });

    // Best-effort attributed audit — the clone authored a new ORG rule, the
    // same mutation as POST /compliance/rules, so it carries that action.
    // `details` names the source published rule so a reviewer can see the
    // curated rule the org copied.
    recordAudit({
      action: 'compliance.rule.create',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'rule',
      targetId: rule.id,
      details: { name: rule.name, target: rule.target, scope: rule.scope, clonedFrom: validation.value.ruleId },
    });

    return sendSuccess(res, 201, { rule });
  }));

  // GET /enforced — merged view of all enforced rules (org + active subscriptions)
  router.get('/enforced', requireComplianceRead, withRoute(async ({ req, res, ctx, orgId }) => {
    const target = req.query.target as 'plugin' | 'pipeline' | undefined;
    // Include the parent's `propagateToChildren` rules for a team, matching what
    // actually blocks at upload/validate time (validate.ts reads the same claim).
    const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
    const enforced = await complianceRuleService.findAllEnforced(orgId, target, parentOrgId);

    // Inherited rules carry `inherited` + `sourceOrgId` from the service; the
    // shared stamp adds the parent's display name (one best-effort lookup, only
    // when any exist) — the SAME labelling the paginated rule list applies.
    const rules = await withInheritedSource(enforced, parentOrgId);

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
  router.post('/preview/impact', requireComplianceRead, withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, SubscribeSchema); // shape: { ruleId: uuid }
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    const rule = await complianceRuleService.findPublishedById(validation.value.ruleId);
    if (!rule) return sendBadRequest(res, 'Rule not found', ErrorCode.VALIDATION_ERROR);

    // Entitlement gate: running a curated-library rule against the org's live
    // entities is a preview of the paid content — gate it the same as subscribe
    // so a non-entitled org can't dry-run the paywalled ruleset. Baseline/
    // un-tagged published rules stay open.
    if (denyIfUnentitled(req, res, complianceFeatureForTags(rule.tags))) return;

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
  router.post('/preview', requireComplianceRead, withRoute(async ({ req, res, ctx }) => {
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

  // POST /:ruleId/pin — pin subscription to current rule version. Governance,
  // not opt-in: pinning freezes the org on today's rule body, so a later upstream
  // tightening (or fix) of the published rule stops applying — the same class of
  // posture change as deactivating. Hence `compliance:write`, like unsubscribe.
  router.post('/:ruleId/pin', requireComplianceWrite, audited('compliance.rule.toggle'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);

    const subscription = await subscriptionService.pinVersion(orgId, ruleId, userId);
    ctx.log('COMPLETED', 'Pinned subscription version', { ruleId });

    // Best-effort attributed audit — the pin succeeded. Reuses
    // `compliance.rule.toggle` (as subscribe and the entitlement sync do): it
    // is the same subscription object whose enforcement changed. `details`
    // records only the pin FLAG — `pinnedVersion` is a full snapshot of the
    // rule row, which can carry sensitive match config.
    recordAudit({
      action: 'compliance.rule.toggle',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'rule',
      targetId: ruleId,
      details: { pinned: true },
    });

    return sendSuccess(res, 200, { subscription });
  }));

  // DELETE /:ruleId/pin — unpin subscription (use latest rule version). Same
  // governance gate + trail as the pin above.
  router.delete('/:ruleId/pin', requireComplianceWrite, audited('compliance.rule.toggle'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);

    const subscription = await subscriptionService.unpinVersion(orgId, ruleId);
    ctx.log('COMPLETED', 'Unpinned subscription version', { ruleId });

    recordAudit({
      action: 'compliance.rule.toggle',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'rule',
      targetId: ruleId,
      details: { pinned: false },
    });

    return sendSuccess(res, 200, { subscription });
  }));

  // DELETE /:ruleId — unsubscribe from a published rule. Requires
  // `compliance:write`: removing a subscription drops the rule from enforcement
  // exactly like DEACTIVATING it (PATCH isActive:false / bulk deactivate, both
  // governance-gated), so leaving unsubscribe at member level bypassed that
  // gate. Same route-level gate as POST /clone.
  router.delete('/:ruleId', requireComplianceWrite, audited('compliance.rule.toggle'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const ruleId = getParam(req.params, 'ruleId');
    if (!ruleId) {
      return sendBadRequest(res, 'ruleId is required', ErrorCode.VALIDATION_ERROR);
    }

    await subscriptionService.unsubscribe(orgId, ruleId, userId);
    ctx.log('COMPLETED', 'Unsubscribed from published rule', { ruleId });

    // Best-effort attributed audit — dropping a subscription removes the rule
    // from enforcement exactly like deactivating it, so it emits the same
    // posture action (with `subscribed: false` to distinguish the two).
    recordAudit({
      action: 'compliance.rule.toggle',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'rule',
      targetId: ruleId,
      details: { subscribed: false, isActive: false },
    });

    return sendSuccess(res, 200, { message: 'Unsubscribed successfully' });
  }));

  return router;
}
