// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendPaginatedNested,
  sendBadRequest,
  sendEntityNotFound,
  ErrorCode,
  audited,
  getParam,
  parsePaginationParams,
  requirePermission,
  validateBody,
  validateQuery,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { complianceScanService } from '../services/compliance-scan-service.js';

/**
 * Compliance scan implementation.
 * Scans re-evaluate existing entities against current rules.
 */

const ScanCreateSchema = z.object({
  target: z.enum(['plugin', 'pipeline', 'all']),
  filter: z.record(z.string(), z.unknown()).optional(),
  dryRun: z.boolean().optional(),
});

// Validate the GET / filter query enums so an invalid value 400s instead of
// being cast to a union and silently returning an empty page.
const ScanListQuerySchema = z.object({
  target: z.enum(['plugin', 'pipeline', 'all']).optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
  triggeredBy: z.enum(['manual', 'scheduled', 'rule-change', 'rule-dry-run']).optional(),
});

export function createScanRoutes(): Router {
  const router = Router();

  // GET / — list scans (paginated, filterable)
  router.get('/', requirePermission('compliance:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const r = validateQuery(req, ScanListQuerySchema);
    if (!r.ok) return sendBadRequest(res, r.error, ErrorCode.VALIDATION_ERROR);
    const filter = r.value;

    const { scans, total } = await complianceScanService.list(filter, orgId, limit, offset);
    ctx.log('COMPLETED', 'Listed compliance scans', { count: scans.length });
    return sendPaginatedNested(res, 'scans', scans, {
      total, limit, offset,
    });
  }));

  // GET /:id — get scan by ID
  router.get('/:id', requirePermission('compliance:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Scan');

    const scan = await complianceScanService.findById(id, orgId);
    if (!scan) return sendEntityNotFound(res, 'Scan');

    ctx.log('COMPLETED', 'Fetched compliance scan', { scanId: id });
    return sendSuccess(res, 200, { scan });
  }));

  // POST / — trigger a new scan. Launches a full org-wide re-evaluation, so it
  // is a heavy write and gated on compliance:write like every other mutation.
  router.post('/', requirePermission('compliance:write'), audited('compliance.scan.create'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ScanCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const scan = await complianceScanService.create(
      orgId,
      userId,
      validation.value.target,
      validation.value.filter as Record<string, unknown> | undefined,
      Boolean(validation.value.dryRun),
    );
    ctx.log('COMPLETED', 'Triggered compliance scan', { scanId: scan.id, target: validation.value.target });

    // Best-effort attributed audit — the scan was persisted. A scan re-evaluates
    // every entity of its target against the current rules and can block ones
    // that passed before, so it carries the same trail as its cancel. Safe
    // scalar metadata only (target + dry-run flag), never the filter body.
    recordAudit({
      action: 'compliance.scan.create',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'scan',
      targetId: scan.id,
      details: { target: validation.value.target, dryRun: Boolean(validation.value.dryRun) },
    });

    return sendSuccess(res, 201, { scan });
  }));

  // POST /:id/cancel — cancel a running scan (mutation → compliance:write)
  router.post('/:id/cancel', requirePermission('compliance:write'), audited('compliance.scan.cancel'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Scan ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const updated = await complianceScanService.cancel(id, orgId, userId);
    if (!updated) return sendEntityNotFound(res, 'Running scan');

    ctx.log('COMPLETED', 'Cancelled compliance scan', { scanId: id });

    // Best-effort attributed audit — the scan cancel succeeded.
    recordAudit({
      action: 'compliance.scan.cancel',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'scan',
      targetId: id,
    });

    return sendSuccess(res, 200, { scan: updated });
  }));

  return router;
}
