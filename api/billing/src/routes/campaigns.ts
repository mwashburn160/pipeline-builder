// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/billing/admin/campaigns` — the identity a set of discount codes belongs to,
 * carrying the budget, the window and the one-per-account rule that cannot be
 * expressed on an individual code (see `models/campaign.ts`).
 *
 * System-org only (`billing:operate`, MFA-grade), like every other discount
 * authoring route: a campaign sets how much the business may give away.
 */

import {
  audited,
  requireAuth,
  requireSystemOrgPermission,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  getParam,
  validateBody,
  parseQueryString,
  parsePage,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { aggregateCampaignLedgerSpend, endCampaign, normalizeCampaignId } from '../helpers/campaign.js';
import { discountsEnabled } from '../helpers/discount-helpers.js';
import { Campaign } from '../models/campaign.js';
import type { CampaignDocument } from '../models/campaign.js';
import { Discount } from '../models/discount.js';
import { CampaignCreateSchema, CampaignUpdateSchema } from '../validation/schemas.js';

const logger = createLogger('billing-campaigns');
// No `allowOrgHeaderOverride`: every route is system-admin scoped, so the org
// context is always the admin's own token org (least privilege).
const AUTH_OPTS = {} as const;

/** Public shape of a campaign. `remainingCents` is derived so the console
 *  doesn't re-do the subtraction and get it wrong. */
function toCampaignResponse(c: CampaignDocument): Record<string, unknown> {
  return {
    id: c._id,
    name: c.name,
    budgetCents: c.budgetCents,
    spentCents: c.spentCents,
    remainingCents: c.budgetCents == null ? null : Math.max(0, c.budgetCents - c.spentCents),
    grantsCount: c.grantsCount,
    exclusive: c.exclusive,
    startsAt: c.startsAt?.toISOString(),
    endsAt: c.endsAt?.toISOString(),
    isActive: c.isActive,
    // DERIVED, so the console never reads a closed or spent campaign as live —
    // the same reason the discount response carries these.
    started: c.startsAt ? c.startsAt.getTime() <= Date.now() : true,
    ended: c.endsAt ? c.endsAt.getTime() < Date.now() : false,
    budgetExhausted: c.budgetCents != null && c.spentCents >= c.budgetCents,
    open: c.isActive
      && (c.startsAt ? c.startsAt.getTime() <= Date.now() : true)
      && !(c.endsAt && c.endsAt.getTime() < Date.now())
      && !(c.budgetCents != null && c.spentCents >= c.budgetCents),
    createdAt: c.createdAt?.toISOString(),
    updatedAt: c.updatedAt?.toISOString(),
  };
}

export function createCampaignRoutes(): Router {
  const router: Router = Router();

  // A campaign only exists to govern discount codes, so it shares the discount
  // surface's flag. SCOPED to the campaign prefix for the reason the discount
  // router scopes its own: this router is mounted at `/billing` ahead of the
  // summary/usage/admin/marketplace/Stripe routers, so a path-less `router.use`
  // would 404 every later billing route too.
  router.use('/admin/campaigns', (_req, res, next) => {
    if (!discountsEnabled()) return sendError(res, 404, 'Discounts are not enabled', ErrorCode.NOT_FOUND);
    next();
  });

  // POST /billing/admin/campaigns — create a campaign.
  router.post('/admin/campaigns', requireAuth(AUTH_OPTS) as RequestHandler, ...requireSystemOrgPermission('billing:operate'), audited('billing.campaign.create'), withRoute(async ({ req, res, orgId, userId }) => {
    const validation = validateBody(req, CampaignCreateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const body = validation.value;

    const id = normalizeCampaignId(body.id);
    // `_id` IS the slug, so create-never-overwrites has to be explicit: a second
    // POST with the same name would otherwise silently adopt (and re-budget) a
    // running campaign.
    if (await Campaign.exists({ _id: id })) {
      return sendError(res, 409, `Campaign '${id}' already exists`, ErrorCode.DUPLICATE_ENTRY);
    }
    if (body.startsAt && body.endsAt && new Date(body.startsAt).getTime() > new Date(body.endsAt).getTime()) {
      return sendBadRequest(res, 'startsAt must be before endsAt', ErrorCode.VALIDATION_ERROR);
    }

    const campaign = await Campaign.create({
      _id: id,
      name: body.name,
      budgetCents: body.budgetCents,
      exclusive: body.exclusive,
      startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
      endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
      spentCents: 0,
      grantsCount: 0,
      isActive: true,
      createdBy: req.user?.sub,
    });

    recordAudit({
      action: 'billing.campaign.create',
      actorId: actorId({ userId }),
      orgId,
      targetId: id,
      details: { campaign: id, budgetCents: body.budgetCents, exclusive: body.exclusive === true },
    });
    logger.info('Campaign created', { campaign: id, budgetCents: body.budgetCents });
    return sendSuccess(res, 201, { campaign: toCampaignResponse(campaign) }, 'Campaign created');
  }));

  // GET /billing/admin/campaigns — list.
  router.get('/admin/campaigns', requireAuth(AUTH_OPTS) as RequestHandler, ...requireSystemOrgPermission('billing:operate'), withRoute(async ({ req, res }) => {
    const { limit, offset } = parsePage(req.query as Record<string, unknown>, { def: 50, max: 200 });
    const active = parseQueryString(req.query.active);
    const filter: Record<string, unknown> = {};
    if (active === 'true') filter.isActive = true;
    if (active === 'false') filter.isActive = false;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit),
      Campaign.countDocuments(filter),
    ]);
    return sendSuccess(res, 200, { campaigns: campaigns.map(toCampaignResponse), pagination: { total, limit, offset } });
  }));

  // GET /billing/admin/campaigns/:id — one campaign, with its codes and the
  // LEDGER-sourced spend (the authority; `spentCents` is the advisory cache).
  router.get('/admin/campaigns/:id', requireAuth(AUTH_OPTS) as RequestHandler, ...requireSystemOrgPermission('billing:operate'), withRoute(async ({ req, res }) => {
    const id = normalizeCampaignId(getParam(req.params, 'id') ?? '');
    const campaign = await Campaign.findById(id);
    if (!campaign) return sendError(res, 404, 'Campaign not found', ErrorCode.NOT_FOUND);

    const [ledger, discountCount, activeDiscountCount] = await Promise.all([
      aggregateCampaignLedgerSpend(id),
      Discount.countDocuments({ campaign: id }),
      Discount.countDocuments({ campaign: id, isActive: true }),
    ]);
    return sendSuccess(res, 200, {
      campaign: toCampaignResponse(campaign),
      codes: { total: discountCount, active: activeDiscountCount },
      // Both, deliberately: a drift between the cache and the ledger is itself
      // the signal that a release failed somewhere.
      ledgerSpend: ledger,
    });
  }));

  // PUT /billing/admin/campaigns/:id — edit, or end with `isActive: false`.
  router.put('/admin/campaigns/:id', requireAuth(AUTH_OPTS) as RequestHandler, ...requireSystemOrgPermission('billing:operate'), audited('billing.campaign.update'), withRoute(async ({ req, res, orgId, userId }) => {
    const validation = validateBody(req, CampaignUpdateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const body = validation.value;
    const id = normalizeCampaignId(getParam(req.params, 'id') ?? '');

    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.budgetCents !== undefined) update.budgetCents = body.budgetCents;
    if (body.exclusive !== undefined) update.exclusive = body.exclusive;
    if (body.startsAt !== undefined) update.startsAt = new Date(body.startsAt);
    if (body.endsAt !== undefined) update.endsAt = new Date(body.endsAt);
    if (body.isActive !== undefined) update.isActive = body.isActive;
    if (Object.keys(update).length === 0) return sendError(res, 400, 'No updatable fields provided', ErrorCode.VALIDATION_ERROR);

    // Lowering a budget below what is already committed is refused rather than
    // clamped: the spend has happened, and a budget under it would read as
    // "remaining: 0" while actually describing a campaign that overran.
    if (body.budgetCents !== undefined) {
      const current = await Campaign.findById(id);
      if (!current) return sendError(res, 404, 'Campaign not found', ErrorCode.NOT_FOUND);
      if (body.budgetCents < current.spentCents) {
        return sendBadRequest(
          res,
          `Budget cannot be set below the ${current.spentCents}c already committed`,
          ErrorCode.VALIDATION_ERROR,
        );
      }
    }

    const campaign = await Campaign.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!campaign) return sendError(res, 404, 'Campaign not found', ErrorCode.NOT_FOUND);

    recordAudit({
      action: 'billing.campaign.update',
      actorId: actorId({ userId }),
      orgId,
      targetId: id,
      details: { campaign: id, ...update },
    });
    return sendSuccess(res, 200, { campaign: toCampaignResponse(campaign) });
  }));

  // POST /billing/admin/campaigns/:id/end — end the campaign AND every code in
  // it. One call, because the read side could always filter by campaign while
  // the write side made you PUT each code (and miss one).
  router.post('/admin/campaigns/:id/end', requireAuth(AUTH_OPTS) as RequestHandler, ...requireSystemOrgPermission('billing:operate'), audited('billing.campaign.end'), withRoute(async ({ req, res, orgId, userId }) => {
    const id = normalizeCampaignId(getParam(req.params, 'id') ?? '');
    if (!(await Campaign.exists({ _id: id }))) return sendError(res, 404, 'Campaign not found', ErrorCode.NOT_FOUND);

    const deactivated = await endCampaign(id);
    recordAudit({
      action: 'billing.campaign.end',
      actorId: actorId({ userId }),
      orgId,
      targetId: id,
      details: { campaign: id, discountsDeactivated: deactivated },
    });
    return sendSuccess(res, 200, { campaign: id, discountsDeactivated: deactivated }, 'Campaign ended');
  }));

  return router;
}
