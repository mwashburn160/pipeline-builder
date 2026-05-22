// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError, sendSuccess, createLogger } from '@pipeline-builder/api-core';
import { Router, Request, Response } from 'express';
import { requireAdminContext } from '../helpers/controller-helper';
import { requireAuth, requireServiceAuth } from '../middleware';
import { isAuditAction } from '../models/audit-event';
import { auditService, type AuditFilter } from '../services/audit-service';
import { parsePagination } from '../utils/pagination';

const logger = createLogger('audit-routes');
const router = Router();

/**
 * GET /audit - List audit events (admin only, org-scoped for org admins)
 * Query: action, targetType, targetId, page, limit
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  try {
    const { action, targetType, targetId, affectedOrgId, actorId } = req.query;
    const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);

    const filter: AuditFilter = {};

    // Org admins can only see their org's events. Sysadmins can filter on
    // either `orgId` (actor's org) or `affectedOrgId` (operated-on org) —
    // the latter is the right query for "what did sysadmins do to org X?".
    if (admin.isOrgAdmin) {
      filter.orgId = req.user!.organizationId;
    } else {
      if (req.query.orgId) filter.orgId = req.query.orgId as string;
      if (affectedOrgId) filter.affectedOrgId = affectedOrgId as string;
      if (actorId) filter.actorId = actorId as string;
    }

    if (action) filter.action = action as string;
    if (targetType) filter.targetType = targetType as string;
    if (targetId) filter.targetId = targetId as string;

    const result = await auditService.findEvents(filter, offset, limitNum);

    sendSuccess(res, 200, result);
  } catch (error) {
    logger.error('[AUDIT] List error', error);
    sendError(res, 500, 'Failed to list audit events');
  }
});

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
  };

  if (!body.action || typeof body.action !== 'string' || !isAuditAction(body.action)) {
    return sendError(res, 400, 'Invalid or unknown action');
  }
  if (!body.actorId || typeof body.actorId !== 'string') {
    return sendError(res, 400, 'actorId is required');
  }

  try {
    await auditService.createEvent({
      action: body.action,
      actorId: body.actorId,
      actorEmail: body.actorEmail,
      orgId: body.orgId,
      // Mirror the pre-refactor behavior: default affectedOrgId to orgId
      // for in-tenant actions; explicit cross-tenant callers (sysadmins
      // acting on another org) pass it themselves.
      affectedOrgId: body.affectedOrgId ?? body.orgId,
      targetType: body.targetType,
      targetId: body.targetId,
      details: body.details,
      ip: body.ip,
    });
    return sendSuccess(res, 200, {});
  } catch (error) {
    logger.warn('[AUDIT] Ingest failed', { action: body.action, error: error instanceof Error ? error.message: String(error) });
    return sendError(res, 500, 'Failed to record audit event');
  }
});

export default router;
