// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import {
  requireAuth,
  requireSystemAdmin,
  sendSuccess,
  sendError,
  createLogger,
  getParam,
  validateBody,
  parseQueryString,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { grantPromotionToOrg, previewPromotion, promotionsEnabled, batchEvaluatePromotion, loadManageableSubscription } from '../helpers/promotion-engine.js';
import type { PromotionContext } from '../helpers/promotion-engine.js';
import { Plan } from '../models/plan.js';
import { Promotion } from '../models/promotion.js';
import type { PromotionDocument } from '../models/promotion.js';
import { Subscription } from '../models/subscription.js';
import { getAuditClient } from '../services/audit.js';
import { PromotionMintSchema, PromotionUpdateSchema, PromotionGrantSchema } from '../validation/schemas.js';

const logger = createLogger('billing-promotions');
// No `allowOrgHeaderOverride`: every route is system-admin scoped and takes its
// target from the body (`targetOrgId`) or path, never the `x-org-id` header —
// so the org context is always the admin's own token org (least privilege).
const AUTH_OPTS = {} as const;

/** Public shape of a promotion — nothing sensitive. */
function toPromotionResponse(p: PromotionDocument): Record<string, unknown> {
  return {
    id: p._id,
    name: p.name,
    campaign: p.campaign,
    value: p.value,
    unit: p.unit,
    kind: p.kind,
    referrerValue: p.referrerValue,
    trigger: p.trigger,
    startsAt: p.startsAt?.toISOString(),
    endsAt: p.endsAt?.toISOString(),
    budgetCents: p.budgetCents,
    spentCents: p.spentCents,
    grantsCount: p.grantsCount,
    perOrgCapCents: p.perOrgCapCents,
    maxGrants: p.maxGrants,
    isActive: p.isActive,
    createdAt: p.createdAt?.toISOString(),
    updatedAt: p.updatedAt?.toISOString(),
  };
}

/**
 * Promotion management routes (system-admin only) — behind BILLING_PROMOTIONS_ENABLED.
 * Promotions AUTO-grant usage credits on lifecycle triggers; these routes let an
 * admin author campaigns, manually grant, preview reach/spend, and read the
 * ledger-derived spend rollup. See docs/billing-discounts.md.
 */
export function createPromotionRoutes(): Router {
  const router: Router = Router();

  // POST /billing/admin/promotions — mint a promotion.
  router.post('/admin/promotions', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const validation = validateBody(req, PromotionMintSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const body = validation.value;

    const _id = `promo_${randomUUID()}`;
    const promo = await Promotion.create({
      _id,
      name: body.name,
      campaign: body.campaign,
      value: body.value,
      unit: body.unit,
      kind: body.kind,
      referrerValue: body.referrerValue,
      trigger: body.trigger,
      startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
      endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
      budgetCents: body.budgetCents,
      perOrgCapCents: body.perOrgCapCents,
      maxGrants: body.maxGrants,
      createdBy: req.user?.sub,
      isActive: true,
    });

    getAuditClient().record({
      action: 'billing.promotion.create',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: _id,
      details: { promotionId: _id, unit: body.unit, value: body.value, event: body.trigger.event, budgetCents: body.budgetCents },
    }, 'billing');

    logger.info('Promotion minted', { promotionId: _id, event: body.trigger.event });
    return sendSuccess(res, 201, { promotion: toPromotionResponse(promo) });
  }));

  // GET /billing/admin/promotions — list (filter by campaign / active).
  router.get('/admin/promotions', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const campaign = parseQueryString(req.query.campaign);
    const active = parseQueryString(req.query.active);
    const filter: Record<string, unknown> = {};
    if (campaign) filter.campaign = campaign;
    // Honor BOTH true and false (the 'Inactive' filter was a no-op before), matching discounts.
    if (active === 'true') filter.isActive = true;
    else if (active === 'false') filter.isActive = false;
    const promos = await Promotion.find(filter).sort({ createdAt: -1 }).limit(500);
    return sendSuccess(res, 200, { promotions: promos.map(toPromotionResponse), total: promos.length });
  }));

  // GET /billing/admin/promotions/:id — inspect one.
  router.get('/admin/promotions/:id', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const id = getParam(req.params, 'id');
    const promo = await Promotion.findById(id);
    if (!promo) return sendError(res, 404, 'Promotion not found');
    return sendSuccess(res, 200, { promotion: toPromotionResponse(promo) });
  }));

  // PUT /billing/admin/promotions/:id — edit / activate / revoke.
  router.put('/admin/promotions/:id', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const id = getParam(req.params, 'id');
    const validation = validateBody(req, PromotionUpdateSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const body = validation.value;

    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.isActive !== undefined) update.isActive = body.isActive;
    if (body.endsAt !== undefined) update.endsAt = new Date(body.endsAt);
    if (body.budgetCents !== undefined) update.budgetCents = body.budgetCents;
    if (body.maxGrants !== undefined) update.maxGrants = body.maxGrants;

    const promo = await Promotion.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!promo) return sendError(res, 404, 'Promotion not found');

    getAuditClient().record({
      action: 'billing.promotion.update',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: id,
      details: { promotionId: id, ...update },
    }, 'billing');
    return sendSuccess(res, 200, { promotion: toPromotionResponse(promo) });
  }));

  // DELETE /billing/admin/promotions/:id — soft-revoke (stops future auto-grants;
  // already-granted credits are NOT clawed back).
  router.delete('/admin/promotions/:id', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const id = getParam(req.params, 'id');
    const promo = await Promotion.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true });
    if (!promo) return sendError(res, 404, 'Promotion not found');
    getAuditClient().record({
      action: 'billing.promotion.revoke',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: id,
      details: { promotionId: id },
    }, 'billing');
    return sendSuccess(res, 200, { promotion: toPromotionResponse(promo) });
  }));

  // POST /billing/admin/promotions/:id/grant — manual grant to one org. Bypasses
  // trigger-event/eligibility matching (admin intent) but still honors budget,
  // per-org idempotency, and the provider realizability invariant.
  router.post('/admin/promotions/:id/grant', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const id = getParam(req.params, 'id');
    const validation = validateBody(req, PromotionGrantSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const { targetOrgId } = validation.value;

    const promo = await Promotion.findById(id);
    if (!promo) return sendError(res, 404, 'Promotion not found');
    if (!promo.isActive) return sendError(res, 409, 'Promotion is not active');

    const subscription = await loadManageableSubscription(targetOrgId);
    if (!subscription) return sendError(res, 404, 'Target org has no active subscription');
    const plan = await Plan.findById(subscription.planId).lean();
    if (!plan) return sendError(res, 404, 'Subscription plan not found');

    const interval: 'monthly' | 'annual' = subscription.interval === 'annual' ? 'annual' : 'monthly';
    const ctx: PromotionContext = { tier: plan.tier, interval, planPriceCents: plan.prices[interval], actorId: req.user?.sub };
    const result = await grantPromotionToOrg(promo, subscription, targetOrgId, ctx);

    getAuditClient().record({
      action: 'billing.promotion.grant',
      actorId: req.user?.sub ?? 'system',
      orgId: targetOrgId,
      targetId: id,
      details: { promotionId: id, targetOrgId, granted: result.granted, cents: result.cents, reason: result.reason },
    }, 'billing');
    logger.info('Promotion manual grant', { targetOrgId, ...result });
    return sendSuccess(res, 200, { result });
  }));

  // POST /billing/admin/promotions/:id/activate — grant across the EXISTING
  // eligible base now (phase 2b). Idempotent per org; budget-bounded (skips are
  // logged). Use /preview first to project reach/spend.
  router.post('/admin/promotions/:id/activate', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const id = getParam(req.params, 'id');
    const promo = await Promotion.findById(id);
    if (!promo) return sendError(res, 404, 'Promotion not found');
    if (!promo.isActive) return sendError(res, 409, 'Promotion is not active');

    const result = await batchEvaluatePromotion(promo);
    getAuditClient().record({
      action: 'billing.promotion.activate',
      actorId: req.user?.sub ?? 'system',
      // Fleet-wide batch action — not scoped to one org; use the system sentinel.
      orgId: 'system',
      targetId: id,
      details: { promotionId: id, granted: result.granted, spentCents: result.spentCents, skippedBudget: result.skippedBudget },
    }, 'billing');
    logger.info('Promotion batch activation', { promotionId: id, ...result });
    return sendSuccess(res, 200, { result });
  }));

  // POST /billing/admin/promotions/:id/preview — projected reach + committed spend.
  router.post('/admin/promotions/:id/preview', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const id = getParam(req.params, 'id');
    const promo = await Promotion.findById(id);
    if (!promo) return sendError(res, 404, 'Promotion not found');
    const projection = await previewPromotion(promo);
    return sendSuccess(res, 200, { projection });
  }));

  // GET /billing/admin/promotions/:id/spend — ledger-derived spend (the authority)
  // alongside the advisory cache, so any drift is visible.
  router.get('/admin/promotions/:id/spend', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!promotionsEnabled()) return sendError(res, 404, 'Promotions are not enabled');
    const id = getParam(req.params, 'id');
    const promo = await Promotion.findById(id);
    if (!promo) return sendError(res, 404, 'Promotion not found');

    const agg = await Subscription.aggregate([
      { $unwind: '$creditLedger' },
      { $match: { 'creditLedger.discountId': `promo:${id}` } },
      { $group: { _id: null, cents: { $sum: '$creditLedger.cents' }, grants: { $sum: 1 } } },
    ]);
    const ledgerCents = agg[0]?.cents ?? 0;
    const ledgerGrants = agg[0]?.grants ?? 0;

    return sendSuccess(res, 200, {
      spend: {
        budgetCents: promo.budgetCents,
        committedCents: ledgerCents, // authoritative (ledger-derived)
        committedGrants: ledgerGrants,
        cachedSpentCents: promo.spentCents, // advisory cache
        cachedGrantsCount: promo.grantsCount,
        remainingBudgetCents: Math.max(0, promo.budgetCents - ledgerCents),
        driftCents: promo.spentCents - ledgerCents,
      },
    });
  }));

  return router;
}
