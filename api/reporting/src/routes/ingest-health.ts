// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode, validateBody, requirePermission } from '@pipeline-builder/api-core';
import { withRoute, requireOrgId, withTenantContext } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';
import { requireIngestScope } from '../middleware/require-ingest-scope.js';

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
 *
 * `GET /` is the user-facing counterpart the Reports UI reads (org-scoped,
 * `reports:read`). Without it the heartbeat was write-only: data nothing could
 * read, and a reports page that couldn't tell a quiet week from a dead forwarder.
 */
const healthSchema = z.object({
  orgId: z.string().min(1).optional(),
  forwarded: z.number().int().min(0).optional(),
  dropped: z.number().int().min(0).optional(),
  lastEventAt: z.string().datetime({ offset: true }).optional(),
});

/**
 * Guards for the USER-facing read below. The mount is the bare machine
 * `requireAuth` (shared with the POST), so the read supplies its own orgId +
 * RLS tenant context and rides `reports:read` — the same capability every other
 * user-facing report read carries, and deliberately NOT the `reporting:ingest`
 * token scope (a dashboard reader holds no machine scope).
 *
 * No `advanced_reporting` gate: freshness applies to the execution reports every
 * `reports:read` holder can see, not just the DORA tab, so gating it on the paid
 * DORA entitlement would leave non-entitled orgs unable to tell a quiet week
 * from a broken forwarder — the exact confusion this endpoint exists to end.
 */
const readGuards = [
  requireOrgId(),
  withTenantContext(),
  requirePermission('reports:read'),
];

export function createIngestHealthRoutes(): Router {
  const router = Router();

  /**
   * GET / — this org's ingestion health for the Reports freshness indicator.
   *
   * `health: null` means the org has NEVER been reported on (no row): a fresh
   * install, or a deployment whose event forwarder was never wired up. The UI
   * says so explicitly rather than calling it stale. Classification (flowing /
   * stale / dropping) is left to the caller — the endpoint reports only what the
   * forwarder wrote, plus `now` so a client with a skewed clock still measures
   * staleness against the server's.
   */
  router.get('/', ...readGuards, withRoute(async ({ res, ctx, orgId }) => {
    const health = await reportingService.getIngestHealth(orgId);
    ctx.log('COMPLETED', 'Read ingest health', { orgId, reported: health !== null });
    return sendSuccess(res, 200, { health, now: new Date().toISOString() });
  }));

  router.post('/', requireIngestScope, withRoute(async ({ req, res, orgId }) => {
    const parsed = validateBody(req, healthSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);

    // Per-org (row keyed on org_id). A multi-tenant forwarder attributes to the
    // resolved org via body `orgId`; otherwise fall back to the token's own org.
    const { orgId: bodyOrgId, ...health } = parsed.value;
    const targetOrgId = bodyOrgId ?? orgId;
    if (!targetOrgId) {
      return sendBadRequest(res, 'ingest-health requires an org-scoped token or a body orgId', ErrorCode.VALIDATION_ERROR);
    }

    await reportingService.recordIngestHealth(targetOrgId, health);
    sendSuccess(res, 200, { ok: true });
  }, { requireOrgId: false }));

  return router;
}
