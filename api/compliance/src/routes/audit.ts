// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendPaginatedNested,
  sendBadRequest,
  ErrorCode,
  parsePaginationParams,
  validateQuery,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { complianceAuditService } from '../services/compliance-check-log-query.js';

// Validate the GET / filter query so malformed input 400s instead of reaching
// the query builder, which does `new Date(dateFrom)` (→ Invalid Date) and
// `eq(scanId)` against a uuid column (→ Postgres cast error) → unhandled 500.
const AuditListQuerySchema = z.object({
  target: z.enum(['plugin', 'pipeline']).optional(),
  action: z.string().max(255).optional(),
  result: z.enum(['pass', 'warn', 'block']).optional(),
  scanId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

/** Audit log read endpoint. */
export function createAuditRoutes(): Router {
  const router = Router();

  // GET / — list audit log entries (paginated, filterable)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const r = validateQuery(req, AuditListQuerySchema);
    if (!r.ok) return sendBadRequest(res, r.error, ErrorCode.VALIDATION_ERROR);
    const filter = r.value;

    const { entries, total } = await complianceAuditService.list(filter, orgId, limit, offset);
    ctx.log('COMPLETED', 'Listed compliance audit log', { count: entries.length });
    return sendPaginatedNested(res, 'entries', entries, {
      total, limit, offset, hasMore: offset + entries.length < total,
    });
  }));

  return router;
}
