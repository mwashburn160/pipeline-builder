// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, hasScope } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';

/** The capability scope the AWS event-ingestion machine credential must carry. */
const INGEST_SCOPE = 'reporting:ingest';

/**
 * Per-org ingestion health (Phase 3). The AWS events Lambda periodically posts
 * its forwarded/dropped counters + the last event timestamp so the Reports UI
 * can surface flowing / stale / dropping. Machine endpoint — authorized by the
 * `reporting:ingest` token scope (same credential the ingest Lambda holds).
 *
 * A single Lambda forwards MANY orgs' pipelines, so it attributes health per
 * resolved org via a body `orgId` — the same cross-org trust boundary the event
 * ingest already relies on (that path resolves org from the pipeline registry
 * under the identical scope). When `orgId` is absent, the token's own org is
 * used, so an org-scoped credential still writes only its own row.
 */
const healthSchema = z.object({
  orgId: z.string().min(1).optional(),
  forwarded: z.number().int().min(0).optional(),
  dropped: z.number().int().min(0).optional(),
  lastEventAt: z.string().datetime({ offset: true }).optional(),
});

export function createIngestHealthRoutes(): Router {
  const router = Router();

  router.post('/', withRoute(async ({ req, res, orgId }) => {
    if (!hasScope(req, INGEST_SCOPE)) {
      return sendError(res, 403, `Token must carry the '${INGEST_SCOPE}' scope`, ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    const parsed = healthSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }

    // Per-org (row keyed on org_id). A multi-tenant forwarder attributes to the
    // resolved org via body `orgId`; otherwise fall back to the token's own org.
    const { orgId: bodyOrgId, ...health } = parsed.data;
    const targetOrgId = bodyOrgId ?? orgId;
    if (!targetOrgId) {
      return sendBadRequest(res, 'ingest-health requires an org-scoped token or a body orgId', ErrorCode.VALIDATION_ERROR);
    }

    await reportingService.recordIngestHealth(targetOrgId, health);
    sendSuccess(res, 200, { ok: true });
  }, { requireOrgId: false }));

  return router;
}
