// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  requirePermission,
  requireSystemAdmin,
  requireFeature,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  parseQueryString,
  parseQueryInt,
  parseQueryIntClamped,
  userHasPermission,
  fetchOrgDescendants,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { billingServiceAuth, getBillingTimeout } from '../helpers/billing-helpers.js';
import { getBillingSummary, listBillingInvoices, getAdminBillingSummary, backfillLedgerFromProvider } from '../helpers/billing-ledger.js';
import { allocateCosts } from '../helpers/cost-allocation.js';
import { fetchSeatUsage } from '../helpers/quota-client.js';
import { getTeamUsage } from '../helpers/team-usage.js';

const logger = createLogger('billing-summary');
const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/** Parse an optional ISO date query param; returns undefined if absent, or null if malformed. */
function parseOptionalDate(raw: unknown): Date | undefined | null {
  const s = parseQueryString(raw);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve the org→team subtree `[self, …descendants]` for a rollup — but only
 * for a caller holding `reports:rollup` who asked (`?includeDescendants=true`).
 * Otherwise just the caller's own org. Shared by the allocation + usage routes
 * so their rollup authz can never drift.
 */
async function resolveSubtreeOrgIds(req: import('express').Request, orgId: string): Promise<string[]> {
  const wantsRollup = req.query.includeDescendants === 'true' && userHasPermission(req, 'reports:rollup');
  if (!wantsRollup) return [orgId];
  const descendants = await fetchOrgDescendants(orgId, {
    service: { host: config.platformService.host, port: config.platformService.port },
    serviceName: 'billing',
    headers: { 'x-org-id': orgId },
    timeout: getBillingTimeout(),
  }).catch(() => undefined);
  return descendants && descendants.length ? descendants : [orgId];
}

/**
 * Billing dashboard routes (root-org-scoped; the root org IS the whole account).
 * The ledger it reads is populated from settled-invoice webhooks.
 *
 * - GET /billing/summary   — gross → discounts/credits → net totals + timeline
 * - GET /billing/invoices  — paginated invoice rows for the table
 */
export function createBillingSummaryRoutes(): Router {
  const router: Router = Router();

  router.get('/summary', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    if (from === null || to === null) return sendError(res, 400, 'from/to must be ISO dates', ErrorCode.VALIDATION_ERROR);
    logger.debug('Billing summary requested', { orgId });
    return sendSuccess(res, 200, await getBillingSummary(orgId, from, to));
  }));

  router.get('/invoices', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    if (from === null || to === null) return sendError(res, 400, 'from/to must be ISO dates', ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 50, 200);
    const offset = parseQueryInt(req.query.offset, 0);
    return sendSuccess(res, 200, await listBillingInvoices(orgId, from, to, limit, offset));
  }));

  // GET /billing/summary/allocation — showback: apportion the account's billed
  // actuals across its org→team subtree by a usage driver (default: seats).
  // Rollup over descendants is gated by `reports:rollup` (like the reporting
  // service) + `?includeDescendants=true`; otherwise it allocates the caller's
  // own org only.
  router.get('/summary/allocation', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    if (from === null || to === null) return sendError(res, 400, 'from/to must be ISO dates', ErrorCode.VALIDATION_ERROR);
    const driver = parseQueryString(req.query.driver) || 'seats';
    if (driver !== 'seats') return sendError(res, 400, `Unsupported allocation driver "${driver}"`, ErrorCode.VALIDATION_ERROR);

    const summary = await getBillingSummary(orgId, from, to);
    const orgIds = await resolveSubtreeOrgIds(req, orgId);

    // Per-org seat driver units (fail-soft → 0 for an org we can't read).
    const children = await Promise.all(orgIds.map(async (id) => {
      const seats = await fetchSeatUsage(id, billingServiceAuth(id));
      return { orgId: id, driverUnits: Math.max(0, seats?.used ?? 0) };
    }));

    logger.debug('Cost allocation computed', { orgId, driver, orgs: orgIds.length });
    return sendSuccess(res, 200, { ...allocateCosts(summary.totals, children, driver), estimated: true });
  }));

  // GET /billing/summary/usage-by-team — per-team CURRENT usage across every
  // quota dimension + seats (feature `team_usage_analytics`, Enterprise-included).
  // Usage only — limits pool at the account root, so per-team caps aren't shown.
  router.get('/summary/usage-by-team', requireAuth(AUTH_OPTS) as RequestHandler, requirePermission('billing:read') as RequestHandler, requireFeature('team_usage_analytics') as RequestHandler, withRoute(async ({ req, res, orgId }) => {
    const orgIds = await resolveSubtreeOrgIds(req, orgId);
    logger.debug('Team usage requested', { orgId, orgs: orgIds.length });
    return sendSuccess(res, 200, { teams: await getTeamUsage(orgIds) });
  }));

  // GET /billing/admin/summary — cross-account finance aggregate + per-org
  // discount/credit impact. `?orgId=` narrows to one account.
  router.get('/admin/summary', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ req, res }) => {
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    if (from === null || to === null) return sendError(res, 400, 'from/to must be ISO dates', ErrorCode.VALIDATION_ERROR);
    const orgId = parseQueryString(req.query.orgId);
    return sendSuccess(res, 200, await getAdminBillingSummary(from, to, orgId));
  }));

  // POST /billing/admin/backfill — one-off: seed the ledger from the
  // provider's historical invoices (idempotent; invoices predate the ledger).
  router.post('/admin/backfill', requireAuth(AUTH_OPTS) as RequestHandler, requireSystemAdmin as RequestHandler, withRoute(async ({ res }) => {
    const result = await backfillLedgerFromProvider();
    logger.info('Ledger backfill requested', result);
    return sendSuccess(res, 200, result);
  }));

  return router;
}
