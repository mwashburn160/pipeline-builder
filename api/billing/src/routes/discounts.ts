// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  requirePermission,
  requireSystemAdmin,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  getParam,
  validateBody,
  parseQueryInt,
  parseQueryIntClamped,
  parseQueryString,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { createBillingEvent } from '../helpers/billing-helpers.js';
import { parseAuthoringForm, encodeDiscountCode } from '../helpers/discount-code.js';
import {
  discountsEnabled,
  withinCeiling,
  generateDiscountId,
  resolveRedeemable,
  applyDiscountToOrg,
  previewDiscountForOrg,
  loadManageableSubscription,
} from '../helpers/discount-helpers.js';
import { Discount } from '../models/discount.js';
import type { DiscountDocument } from '../models/discount.js';
import { getAuditClient } from '../services/audit.js';
import { DiscountMintSchema, DiscountUpdateSchema, DiscountApplySchema, DiscountRedeemSchema } from '../validation/schemas.js';

const logger = createLogger('billing-discounts');
const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/** Public shape of a discount record (nothing sensitive — tokens are separate). */
function toDiscountResponse(d: DiscountDocument): Record<string, unknown> {
  return {
    id: d._id,
    value: d.value,
    unit: d.unit,
    kind: d.kind,
    campaign: d.campaign,
    alias: d.alias,
    targetOrgId: d.targetOrgId,
    maxRedemptions: d.maxRedemptions,
    timesRedeemed: d.timesRedeemed,
    redeemBy: d.redeemBy?.toISOString(),
    appliesToTiers: d.appliesToTiers,
    isActive: d.isActive,
    createdAt: d.createdAt?.toISOString(),
    updatedAt: d.updatedAt?.toISOString(),
  };
}

/**
 * Discount management + redemption routes (behind BILLING_DISCOUNTS_ENABLED).
 * See docs/billing-discounts.md.
 *
 * Admin (system-admin): mint, issue token (Mode B), direct grant (Mode A),
 * list/inspect, edit/revoke. Self-service (billing:manage): redeem, remove.
 */
export function createDiscountRoutes(): Router {
  const router: Router = Router();

  // ── Generation ───────────────────────────────────────────────────

  // POST /billing/admin/discounts — mint a discount record.
  router.post('/admin/discounts', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const validation = validateBody(req, DiscountMintSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const body = validation.value;

    const spec = parseAuthoringForm(body.code);
    if ('error' in spec) return sendError(res, 400, spec.error, ErrorCode.VALIDATION_ERROR);
    if (!withinCeiling(spec)) return sendError(res, 400, 'Discount value exceeds the configured ceiling', 'DISCOUNT_CEILING_EXCEEDED');

    const _id = generateDiscountId();
    const discount = await Discount.create({
      _id,
      value: spec.value,
      unit: spec.unit,
      kind: spec.kind,
      campaign: body.campaign ?? spec.campaign,
      alias: body.alias?.toUpperCase(),
      targetOrgId: body.targetOrgId,
      maxRedemptions: body.maxRedemptions,
      redeemBy: body.redeemBy ? new Date(body.redeemBy) : undefined,
      appliesToTiers: body.appliesToTiers,
      createdBy: req.user?.sub,
      isActive: true,
    });

    await createBillingEvent(body.targetOrgId ?? orgId, 'discount_generated', { discountId: _id, kind: spec.kind, unit: spec.unit, value: spec.value }, undefined, req.user?.sub);
    getAuditClient().record({
      action: 'billing.discount.generate',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: _id,
      details: { discountId: _id, kind: spec.kind, unit: spec.unit, value: spec.value, targetOrgId: body.targetOrgId },
    }, 'billing');

    logger.info('Discount minted', { discountId: _id, kind: spec.kind });
    return sendSuccess(res, 201, { discount: toDiscountResponse(discount) });
  }));

  // ── Issuance ─────────────────────────────────────────────────────

  // POST /billing/admin/discounts/:id/token — Mode B: mint/re-issue an opaque token.
  router.post('/admin/discounts/:id/token', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const id = getParam(req.params, 'id');
    if (!id) return sendError(res, 400, 'id is required');
    const discount = await Discount.findById(id);
    if (!discount) return sendError(res, 404, 'Discount not found', ErrorCode.NOT_FOUND);
    if (!discount.isActive) return sendError(res, 409, 'Cannot issue a token for an inactive discount', 'DISCOUNT_INACTIVE');

    let token: string;
    try {
      token = encodeDiscountCode({
        id: discount._id,
        value: discount.value,
        unit: discount.unit,
        kind: discount.kind,
        ...(discount.targetOrgId ? { targetOrgId: discount.targetOrgId } : {}),
      });
    } catch (error) {
      logger.error('Token issuance failed — discount signing key unavailable', { discountId: id, error });
      return sendError(res, 501, 'Discount code signing is not configured');
    }

    await createBillingEvent(discount.targetOrgId ?? orgId, 'discount_issued', { discountId: id }, undefined, req.user?.sub);
    getAuditClient().record({
      action: 'billing.discount.issue',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: id,
      details: { discountId: id },
    }, 'billing');
    // The token itself is a bearer credential — never logged or audited.
    return sendSuccess(res, 200, { token });
  }));

  // POST /billing/admin/discounts/:id/apply — Mode A: direct grant to a target org.
  router.post('/admin/discounts/:id/apply', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const id = getParam(req.params, 'id');
    if (!id) return sendError(res, 400, 'id is required');
    const validation = validateBody(req, DiscountApplySchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const { targetOrgId } = validation.value;

    const discount = await Discount.findById(id);
    if (!discount) return sendError(res, 404, 'Discount not found', ErrorCode.NOT_FOUND);

    const result = await applyDiscountToOrg(targetOrgId, discount, req.user?.sub);
    if (!result.ok) return sendError(res, result.status, result.error, result.code);

    getAuditClient().record({
      action: 'billing.discount.apply',
      actorId: req.user?.sub ?? 'system',
      orgId: targetOrgId,
      targetId: id,
      details: { discountId: id, kind: discount.kind, affectedOrgId: targetOrgId, via: 'system' },
    }, 'billing');
    logger.info('Discount granted (system)', { discountId: id, targetOrgId });
    return sendSuccess(res, 200, { discount: toDiscountResponse(discount), applied: result.kind, priceBreakdown: result.breakdown });
  }));

  // POST /billing/admin/discounts/:id/preview — system dry-run on a target org.
  router.post('/admin/discounts/:id/preview', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const id = getParam(req.params, 'id');
    if (!id) return sendError(res, 400, 'id is required');
    const validation = validateBody(req, DiscountApplySchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const discount = await Discount.findById(id);
    if (!discount) return sendError(res, 404, 'Discount not found', ErrorCode.NOT_FOUND);
    const preview = await previewDiscountForOrg(validation.value.targetOrgId, discount);
    if (!preview.ok) return sendError(res, preview.status, preview.error, preview.code);
    return sendSuccess(res, 200, { applied: preview.kind, priceBreakdown: preview.breakdown });
  }));

  // ── Management ───────────────────────────────────────────────────

  // GET /billing/admin/discounts — list (filtered + paginated). Never a token.
  router.get('/admin/discounts', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const limit = parseQueryIntClamped(req.query.limit, 50, 200);
    const offset = parseQueryInt(req.query.offset, 0);
    const filter: Record<string, unknown> = {};
    const campaign = parseQueryString(req.query.campaign);
    const targetOrgId = parseQueryString(req.query.targetOrgId);
    const active = parseQueryString(req.query.active);
    if (campaign) filter.campaign = campaign;
    if (targetOrgId) filter.targetOrgId = targetOrgId;
    if (active === 'true') filter.isActive = true;
    if (active === 'false') filter.isActive = false;

    const [discounts, total] = await Promise.all([
      Discount.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit),
      Discount.countDocuments(filter),
    ]);
    return sendSuccess(res, 200, { discounts: discounts.map(toDiscountResponse), pagination: { total, limit, offset } });
  }));

  // GET /billing/admin/discounts/:id — inspect one.
  router.get('/admin/discounts/:id', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const id = getParam(req.params, 'id');
    if (!id) return sendError(res, 400, 'id is required');
    const discount = await Discount.findById(id);
    if (!discount) return sendError(res, 404, 'Discount not found', ErrorCode.NOT_FOUND);
    return sendSuccess(res, 200, { discount: toDiscountResponse(discount) });
  }));

  // PUT /billing/admin/discounts/:id — edit / revoke (isActive:false).
  router.put('/admin/discounts/:id', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const id = getParam(req.params, 'id');
    if (!id) return sendError(res, 400, 'id is required');
    const validation = validateBody(req, DiscountUpdateSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const body = validation.value;

    const update: Record<string, unknown> = {};
    if (body.isActive !== undefined) update.isActive = body.isActive;
    if (body.maxRedemptions !== undefined) update.maxRedemptions = body.maxRedemptions;
    if (body.redeemBy !== undefined) update.redeemBy = new Date(body.redeemBy);
    if (body.appliesToTiers !== undefined) update.appliesToTiers = body.appliesToTiers;
    if (Object.keys(update).length === 0) return sendError(res, 400, 'No updatable fields provided');

    const discount = await Discount.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!discount) return sendError(res, 404, 'Discount not found', ErrorCode.NOT_FOUND);

    // A revoke (isActive:false) is the notable, auditable transition.
    if (body.isActive === false) {
      await createBillingEvent(discount.targetOrgId ?? orgId, 'discount_revoked', { discountId: id }, undefined, req.user?.sub);
      getAuditClient().record({
        action: 'billing.discount.revoke',
        actorId: req.user?.sub ?? 'system',
        orgId,
        targetId: id,
        details: { discountId: id },
      }, 'billing');
    }
    return sendSuccess(res, 200, { discount: toDiscountResponse(discount) });
  }));

  // DELETE /billing/admin/discounts/:id — hard revoke.
  router.delete('/admin/discounts/:id', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const id = getParam(req.params, 'id');
    if (!id) return sendError(res, 400, 'id is required');
    const discount = await Discount.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true });
    if (!discount) return sendError(res, 404, 'Discount not found', ErrorCode.NOT_FOUND);
    await createBillingEvent(discount.targetOrgId ?? orgId, 'discount_revoked', { discountId: id }, undefined, req.user?.sub);
    getAuditClient().record({
      action: 'billing.discount.revoke',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: id,
      details: { discountId: id },
    }, 'billing');
    return sendSuccess(res, 200, { discount: toDiscountResponse(discount) });
  }));

  // ── Self-service redemption ──────────────────────────────────────

  // POST /billing/subscriptions/:id/discounts/preview — self-service dry-run.
  // Gated (billing:read) so a read-only member can't enumerate discount codes.
  router.post('/subscriptions/:id/discounts/preview', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const validation = validateBody(req, DiscountRedeemSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);
    const discount = await resolveRedeemable(validation.value.code);
    if (!discount) return sendError(res, 404, 'Invalid or unknown discount code', 'DISCOUNT_NOT_FOUND');
    const preview = await previewDiscountForOrg(orgId, discount);
    if (!preview.ok) return sendError(res, preview.status, preview.error, preview.code);
    return sendSuccess(res, 200, { applied: preview.kind, priceBreakdown: preview.breakdown });
  }));

  // POST /billing/subscriptions/:id/discounts — redeem a token or public alias.
  router.post('/subscriptions/:id/discounts', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const validation = validateBody(req, DiscountRedeemSchema);
    if (!validation.ok) return sendError(res, 400, validation.error);

    const discount = await resolveRedeemable(validation.value.code);
    if (!discount) return sendError(res, 404, 'Invalid or unknown discount code', 'DISCOUNT_NOT_FOUND');

    const result = await applyDiscountToOrg(orgId, discount, req.user?.sub);
    if (!result.ok) return sendError(res, result.status, result.error, result.code);

    getAuditClient().record({
      action: 'billing.discount.apply',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: discount._id,
      details: { discountId: discount._id, kind: discount.kind, affectedOrgId: orgId, via: 'self-service' },
    }, 'billing');
    logger.info('Discount redeemed (self-service)', { discountId: discount._id, orgId });
    return sendSuccess(res, 200, { discount: toDiscountResponse(discount), applied: result.kind, priceBreakdown: result.breakdown });
  }));

  // DELETE /billing/subscriptions/:id/discounts/:discountId — stop a standing
  // recurring discount (no more per-period credits). Credits already granted
  // persist on the balance until consumed — there is nothing to detach at the
  // provider (discounts are usage credits, not coupons).
  router.delete('/subscriptions/:id/discounts/:discountId', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:manage') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled');
    const discountId = getParam(req.params, 'discountId');
    if (!discountId) return sendError(res, 400, 'discountId is required');

    const subscription = await loadManageableSubscription(orgId);
    if (!subscription) return sendError(res, 404, 'No active subscription');
    if (subscription.recurringDiscount?.discountId !== discountId) {
      return sendError(res, 404, 'No active recurring discount with that id', ErrorCode.NOT_FOUND);
    }

    subscription.recurringDiscount = null;
    await subscription.save();
    await createBillingEvent(orgId, 'discount_removed', { discountId }, subscription._id.toString(), req.user?.sub);
    getAuditClient().record({
      action: 'billing.discount.remove',
      actorId: req.user?.sub ?? 'system',
      orgId,
      targetId: discountId,
      details: { discountId, subscriptionId: subscription._id.toString() },
    }, 'billing');
    return sendSuccess(res, 200, { removed: discountId });
  }));

  return router;
}
