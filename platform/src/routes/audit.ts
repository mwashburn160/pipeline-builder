// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin, parseQueryString, sendError, sendSuccess, createLogger, parsePaginationParams } from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import { verifyAuditChain } from '../helpers/audit-chain.js';
import { requireAdminContext, requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { requireAuth, requireServiceAuth } from '../middleware/index.js';
import { isAuditAction } from '../models/audit-event.js';
import { auditService, type AuditFilter } from '../services/audit-service.js';

const logger = createLogger('audit-routes');
const router: Router = Router();

/** Actions whose name marks them a failure outcome (e.g. `plugin.build.failed`,
 *  `plugin.build.timeout`). Hoisted so the ingest path doesn't recompile it. */
const FAILURE_ACTION = /\.(failed|timeout)$/;

/**
 * GET /audit - List audit events (admin only, org-scoped for org admins)
 * Query: action, targetType, targetId, page, limit
 */
router.get('/', requireAuth, withController('List audit events', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  // Parse possibly-array query strings safely. Express's qs parser can
  // return `string | string[] | ParsedQs` — `parseQueryString` collapses
  // all of those to `string | undefined`.
  const action = parseQueryString(req.query.action);
  const targetType = parseQueryString(req.query.targetType);
  const targetId = parseQueryString(req.query.targetId);
  const affectedOrgId = parseQueryString(req.query.affectedOrgId);
  const actorId = parseQueryString(req.query.actorId);
  const orgIdQuery = parseQueryString(req.query.orgId);
  const groupId = parseQueryString(req.query.groupId);
  const impersonatorId = parseQueryString(req.query.impersonatorId);
  const requestId = parseQueryString(req.query.requestId);
  const outcomeQuery = parseQueryString(req.query.outcome);
  const { offset, limit: limitNum } = parsePaginationParams(req.query);

  const filter: AuditFilter = {};

  if (admin.isOrgAdmin) {
    // Org admins see events where their org was either the actor (orgId)
    // OR the affected target (affectedOrgId). `orgIdOrAffected` translates
    // to a Mongo `$or` in the service so a sysadmin's cross-tenant action
    // ON their org is visible alongside their own in-tenant actions.
    filter.orgIdOrAffected = req.user!.organizationId;
  } else {
    if (orgIdQuery) filter.orgId = orgIdQuery;
    if (affectedOrgId) filter.affectedOrgId = affectedOrgId;
    if (actorId) filter.actorId = actorId;
  }

  if (action) filter.action = action;
  if (targetType) filter.targetType = targetType;
  if (targetId) filter.targetId = targetId;
  if (groupId) filter.groupId = groupId;
  if (impersonatorId) filter.impersonatorId = impersonatorId;
  if (requestId) filter.requestId = requestId;
  if (outcomeQuery === 'success' || outcomeQuery === 'failure') filter.outcome = outcomeQuery;

  const result = await auditService.findEvents(filter, offset, limitNum);

  sendSuccess(res, 200, result);
}));

/**
 * GET /audit/verify?orgId=... — verify a tenant's audit hash chain (sysadmin
 * only). Walks the chain for `orgId` (the `affectedOrgId ?? orgId` chain key)
 * and returns `{ ok, brokenAt?, count }`. `ok:false` with `brokenAt` set means a
 * stored row was ALTERED or DELETED after the fact — a tamper signal. This reads
 * nothing sensitive back (only hashes + a boolean), but it exposes cross-tenant
 * chain state, so it's gated to platform sysadmins, not org admins.
 */
router.get('/verify', requireAuth, withController('Verify audit chain', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const orgId = parseQueryString(req.query.orgId);
  if (!orgId) {
    return sendError(res, 400, 'orgId query parameter is required');
  }

  const result = await verifyAuditChain(orgId);
  sendSuccess(res, 200, result);
}));

/**
 * POST /audit/events  internal ingest endpoint for non-platform services.
 *
 * Used today by the plugin build worker (api/plugin) to push
 * `plugin.build.{completed,failed,timeout}` events into the MongoDB audit
 * log. Auth: service-only JWT (rejects user tokens). Body validation is
 * strict on `action` to keep the action vocabulary closed; everything else
 * is optional. Returns 200 with no body on success.
 *
 * Fire-and-forget by convention  callers shouldn't block on the response.
 *.
 */
router.post('/events', requireServiceAuth, async (req: Request, res: Response) => {
  const body = req.body as {
    action?: string;
    actorId?: string;
    actorEmail?: string;
    orgId?: string;
    affectedOrgId?: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
    ip?: string;
    // Transport/correlation context a service caller may forward. `actorRole`
    // and `impersonatorId` are deliberately NOT read from the body — those are
    // forensic identity claims that are only trustworthy when derived from a
    // verified `req.user` (the platform `audit()` helper), never self-asserted
    // by a service token.
    userAgent?: string;
    requestId?: string;
    traceId?: string;
    outcome?: 'success' | 'failure';
  };

  if (!body.action || typeof body.action !== 'string' || !isAuditAction(body.action)) {
    return sendError(res, 400, 'Invalid or unknown action');
  }
  if (!body.actorId || typeof body.actorId !== 'string') {
    return sendError(res, 400, 'actorId is required');
  }

  // The service-token's `organizationId` is the authoritative tenant —
  // a caller cannot record events under another org's name just by setting
  // `body.orgId`. Sysadmin service tokens (issued with isSuperAdmin) are the
  // only callers allowed to push cross-tenant events (i.e. `affectedOrgId`
  // != token org), since they may legitimately ingest on behalf of any org.
  const tokenOrgId = req.user?.organizationId;
  const isSysadminService = isSystemAdmin(req);
  if (body.orgId && tokenOrgId && body.orgId !== tokenOrgId && !isSysadminService) {
    return sendError(res, 403, 'orgId does not match authenticated service org');
  }
  // Force orgId to the token's tenant when the body omitted it or for
  // non-sysadmin callers — never trust the body field for tenant binding.
  const effectiveOrgId = (!isSysadminService && tokenOrgId) ? tokenOrgId : (body.orgId ?? tokenOrgId);

  const effectiveAffectedOrgId = body.affectedOrgId ?? effectiveOrgId;
  if (
    body.affectedOrgId
    && tokenOrgId
    && body.affectedOrgId !== tokenOrgId
    && !isSysadminService
  ) {
    return sendError(res, 403, 'affectedOrgId not allowed for this service token');
  }

  // Derive outcome: honour an explicit body value, else infer from the action
  // vocabulary so `plugin.build.{failed,timeout}` land as failures without the
  // worker having to set it.
  const outcome: 'success' | 'failure' = body.outcome
    ?? (FAILURE_ACTION.test(body.action) ? 'failure' : 'success');

  try {
    await auditService.createEvent({
      action: body.action,
      actorId: body.actorId,
      actorEmail: body.actorEmail,
      orgId: effectiveOrgId,
      // Mirror the pre-refactor behavior: default affectedOrgId to orgId
      // for in-tenant actions; explicit cross-tenant callers (sysadmin
      // services acting on another org) pass it themselves.
      affectedOrgId: effectiveAffectedOrgId,
      targetType: body.targetType,
      targetId: body.targetId,
      outcome,
      details: body.details,
      ip: body.ip,
      // Transport context only (see body type comment) — forensic identity
      // claims are never accepted from the service body.
      userAgent: body.userAgent,
      requestId: body.requestId,
      traceId: body.traceId,
    });
    return sendSuccess(res, 200, {});
  } catch (error) {
    logger.warn('[AUDIT] Ingest failed', { action: body.action, error: error instanceof Error ? error.message: String(error) });
    return sendError(res, 500, 'Failed to record audit event');
  }
});

export default router;
