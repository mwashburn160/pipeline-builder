// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, validateBody, requirePermission, SYSTEM_ORG_ID, audited, recordAuthzDenial, type QuotaService } from '@pipeline-builder/api-core';
import { withRoute, requireOrgId, withTenantContext, checkQuota } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';
import { countIngestRejection, recordIngestBatch } from '../helpers/ingest-audit.js';
import { requireIngestScope } from '../middleware/require-ingest-scope.js';

/**
 * Per-org ingestion health. The AWS events Lambda periodically posts
 * its forwarded/dropped counters + the last event timestamp so the Reports UI
 * can surface flowing / stale / dropping. Machine endpoint — authorized by the
 * `reporting:ingest` token scope (same credential the ingest Lambda holds).
 *
 * A single deployment-wide Lambda forwards MANY orgs' pipelines, so it
 * attributes health per org via a body `orgId`. Only a credential bound to no
 * tenant (no org, or the system org) may name another org that way; a
 * tenant-scoped key writes only its own row, and naming a different org is a
 * 403 (see the POST below for why this is NOT the event-ingest trust boundary).
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
 *
 * Ends with the apiCalls CHECK: the app-routes mount for this prefix only METERS
 * (the machine POST must never be refused for quota — a dropped heartbeat would
 * misreport the forwarder as broken), so the user read gates itself here, after
 * the org + permission guards so a refused request costs no quota read.
 */
function readGuards(quotaService: QuotaService) {
  return [
    requireOrgId(),
    withTenantContext(),
    requirePermission('reports:read'),
    checkQuota(quotaService, 'apiCalls'),
  ];
}

export function createIngestHealthRoutes(quotaService: QuotaService): Router {
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
  router.get('/', ...readGuards(quotaService), withRoute(async ({ res, ctx, orgId }) => {
    const health = await reportingService.getIngestHealth(orgId);
    ctx.log('COMPLETED', 'Read ingest health', { orgId, reported: health !== null });
    return sendSuccess(res, 200, { health, now: new Date().toISOString() });
  }));

  router.post('/', requireIngestScope, audited('reporting.ingest.batch'), withRoute(async ({ req, res, orgId }) => {
    const parsed = validateBody(req, healthSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);

    // Per-org (row keyed on org_id). A multi-tenant forwarder — one Lambda over
    // many orgs, holding a credential that is NOT org-scoped — attributes each
    // row via a body `orgId`.
    //
    // Attributing ACROSS orgs is the deployment-wide forwarder's privilege, not
    // every ingest credential's. `reporting:ingest` is the only gate on this
    // route, and a tenant's own ingest key carries it too — so while the body
    // value took precedence unconditionally, any tenant could name another org
    // and overwrite that org's freshness row, making its Reports page read
    // "flowing" while its forwarder was dead (or the reverse). The module doc
    // already claimed an org-scoped credential "writes only its own row";
    // nothing enforced it. Note this is NOT the trust boundary event ingest
    // relies on: that path resolves the org from the pipeline REGISTRY, never
    // from the request body.
    //
    // So a body `orgId` is honoured only from a credential that is not bound to
    // a tenant — no org at all, or the system org, which is what the
    // deployment-wide Lambda holds. A tenant-scoped key writes its own row.
    const { orgId: bodyOrgId, ...health } = parsed.value;
    const mayAttributeCrossOrg = !orgId || orgId === SYSTEM_ORG_ID;
    if (bodyOrgId && !mayAttributeCrossOrg && bodyOrgId !== orgId) {
      // A tenant credential naming another org is an attempt to rewrite that
      // org's freshness row — recorded on the authz trail, not just refused.
      recordAuthzDenial(req, 'ingest-health:cross-org');
      countIngestRejection('cross_org_health');
      return sendError(res, 403, 'An org-scoped credential cannot report health for another organization', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    const targetOrgId = (mayAttributeCrossOrg ? bodyOrgId : undefined) ?? orgId;
    if (!targetOrgId) {
      return sendBadRequest(res, 'ingest-health requires an org-scoped token or a body orgId', ErrorCode.VALIDATION_ERROR);
    }

    await reportingService.recordIngestHealth(targetOrgId, health);
    recordIngestBatch(req, {
      source: 'ingest-health',
      affectedOrgId: targetOrgId,
      outcome: 'success',
      counts: { forwarded: health.forwarded ?? 0, dropped: health.dropped ?? 0 },
    });
    sendSuccess(res, 200, { ok: true });
  }, { requireOrgId: false }));

  return router;
}
