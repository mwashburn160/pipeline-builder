// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendPaginatedNested, parsePaginationParams } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { complianceAuditService } from '../services/compliance-audit-service';

/** Feature #2: Audit log read endpoint. */
export function createAuditRoutes(): Router {
  const router = Router();

  // GET / — list audit log entries (paginated, filterable)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const filter = {
      target: req.query.target as 'plugin' | 'pipeline' | undefined,
      action: req.query.action as string | undefined,
      result: req.query.result as 'pass' | 'warn' | 'block' | undefined,
      scanId: req.query.scanId as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
    };

    const { entries, total } = await complianceAuditService.list(filter, orgId, limit, offset);
    ctx.log('COMPLETED', 'Listed compliance audit log', { count: entries.length });
    return sendPaginatedNested(res, 'entries', entries, {
      total, limit, offset, hasMore: offset + entries.length < total,
    });
  }));

  return router;
}
