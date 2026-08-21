// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess, sendBadRequest, sendError, sendPaginatedNested, ErrorCode, hasScope,
  requirePermission, requireFeature, parsePaginationParams,
} from '@pipeline-builder/api-core';
import { withRoute, requireOrgId, withTenantContext } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';

/** The capability scope the incident-webhook machine credential must carry. */
const INGEST_SCOPE = 'reporting:ingest';

/** Default Alertmanager label read for the deploy environment (configurable via `?environmentLabel=`). */
const DEFAULT_ENV_LABEL = 'environment';

/**
 * Upper bound on alerts accepted in a single Alertmanager POST. A webhook can
 * batch an unbounded group; without a ceiling each alert is a serial upsert (and
 * an org-cache invalidation), so a pathological payload is a cost-amplification
 * vector. Over-cap is rejected (400) so the sender re-batches — never silently
 * truncated (which would drop incidents).
 */
const MAX_ALERTMANAGER_ALERTS = 1000;

/**
 * Production incident webhook + org-admin config surface (Phase 5 / 5b).
 *
 * MACHINE writes (org from the token identity, gated by the `reporting:ingest`
 * scope — the same credential the event forwarder holds):
 *   - `POST /`             — generic incident upsert (PagerDuty/Datadog/any JSON).
 *   - `POST /alertmanager` — native Alertmanager webhook adapter: reshapes the
 *     batched `{alerts:[…]}` payload into one incident per alert and upserts each.
 *
 * ORG-ADMIN reads/tools (user JWT, org from the token, `reports:read` +
 * `advanced_reporting`; per-route middleware supplies orgId + RLS tenant context
 * since the mount is the bare machine `requireAuth`):
 *   - `GET  /`     — recent incidents + their deploy correlation + resolved state.
 *   - `POST /test` — a non-persisting wiring-test dry-run: would a synthetic
 *     incident opening now correlate to a recent deploy under the org's window?
 *
 * Each machine POST upserts by (org, incidentId); DORA correlates each incident
 * to the most recent successful deploy to its `environment`, producing automated
 * post-deploy CFR + real MTTR.
 */
const incidentSchema = z.object({
  incidentId: z.string().min(1).max(255),
  environment: z.string().min(1).max(255),
  // When the incident opened / resolved (ISO 8601, offset required). `resolvedAt`
  // is optional — an open incident omits it; a later resolve webhook sets it.
  openedAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
  severity: z.string().min(1).max(50),
});

/**
 * Standard Alertmanager webhook payload (the shape a `webhook_config` receiver
 * POSTs). We only read the per-alert fields we map; everything else is ignored.
 */
const alertmanagerSchema = z.object({
  status: z.string().optional(),
  groupKey: z.string().optional(),
  alerts: z.array(z.object({
    status: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    fingerprint: z.string().optional(),
  })).default([]),
});

/** True for a usable ISO instant that isn't Alertmanager's "no end" zero value. */
function isRealInstant(v: string | undefined): v is string {
  return typeof v === 'string' && !v.startsWith('0001-01-01') && Number.isFinite(Date.parse(v));
}

/** The synthetic-incident wiring test only needs an optional environment. */
const testSchema = z.object({
  environment: z.string().min(1).max(255).optional(),
});

/** The per-route guards for the org-admin surfaces (mount is the bare machine requireAuth). */
const adminGuards = [
  requireOrgId(),
  withTenantContext(),
  requirePermission('reports:read'),
  requireFeature('advanced_reporting'),
];

export function createIncidentRoutes(): Router {
  const router = Router();

  // ── Machine write: generic incident upsert ──────────────────────────────
  router.post('/', withRoute(async ({ req, res, orgId }) => {
    // Machine endpoint — only a token carrying `reporting:ingest` may write an
    // incident (the org-scoped credential the user's incident tool holds). The
    // org is taken from the token identity below, never from the body, so a
    // token can't file an incident against a foreign org.
    if (!hasScope(req, INGEST_SCOPE)) {
      return sendError(res, 403, `Token must carry the '${INGEST_SCOPE}' scope`, ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    if (!orgId) {
      return sendBadRequest(res, 'incident ingest requires an org-scoped token', ErrorCode.VALIDATION_ERROR);
    }

    const parsed = incidentSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }

    await reportingService.recordIncident(orgId, parsed.data);
    sendSuccess(res, 200, { incidentId: parsed.data.incidentId, ok: true });
  }, { requireOrgId: false }));

  // ── Machine write: native Alertmanager adapter ──────────────────────────
  // Maps each alert in the batched payload → one incident: incidentId =
  // fingerprint (or the group key), environment = the configurable label
  // (`?environmentLabel=`, default `environment`), severity = the `severity`
  // label, openedAt = startsAt, resolvedAt = endsAt when the alert is resolved.
  // Same `reporting:ingest` auth + idempotent (org, incidentId) upsert as `/`.
  router.post('/alertmanager', withRoute(async ({ req, res, orgId }) => {
    if (!hasScope(req, INGEST_SCOPE)) {
      return sendError(res, 403, `Token must carry the '${INGEST_SCOPE}' scope`, ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    if (!orgId) {
      return sendBadRequest(res, 'incident ingest requires an org-scoped token', ErrorCode.VALIDATION_ERROR);
    }

    const parsed = alertmanagerSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }

    const envLabel = typeof req.query.environmentLabel === 'string' && req.query.environmentLabel.length > 0
      ? req.query.environmentLabel
      : DEFAULT_ENV_LABEL;

    const { alerts, groupKey, status: groupStatus } = parsed.data;
    // Cap the batch: an unbounded alert array is a per-alert-upsert amplification
    // vector. Reject (don't truncate) so the sender re-batches without losing any.
    if (alerts.length > MAX_ALERTMANAGER_ALERTS) {
      return sendBadRequest(
        res,
        `alerts batch exceeds the maximum of ${MAX_ALERTMANAGER_ALERTS} — split into smaller POSTs`,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // BATCH the upserts: map every alert, then collapse by incidentId (last write
    // wins — a resolve later in the same payload supersedes its firing). One
    // upsert per DISTINCT incident, so a duplicate fingerprint doesn't drive a
    // redundant write + org-cache invalidation.
    const byIncident = new Map<string, z.infer<typeof incidentSchema>>();
    let skipped = 0;
    for (const alert of alerts) {
      const labels = alert.labels ?? {};
      const environment = labels[envLabel];
      const incidentId = alert.fingerprint || groupKey;
      // An alert with no stable id, no environment label, or no valid start can't
      // be mapped to a correlatable incident — count it as skipped, don't guess.
      if (!incidentId || !environment || !isRealInstant(alert.startsAt)) { skipped++; continue; }

      const resolved = (alert.status ?? groupStatus) === 'resolved';
      const resolvedAt = resolved && isRealInstant(alert.endsAt) ? alert.endsAt : undefined;
      const id = incidentId.slice(0, 255);
      byIncident.set(id, {
        incidentId: id,
        environment: environment.slice(0, 255),
        openedAt: alert.startsAt,
        resolvedAt,
        severity: (labels.severity || 'unknown').slice(0, 50),
      });
    }

    for (const incident of byIncident.values()) {
      await reportingService.recordIncident(orgId, incident);
    }

    sendSuccess(res, 200, { received: alerts.length, ingested: byIncident.size, skipped, ok: true });
  }, { requireOrgId: false }));

  // ── Org-admin: recent incidents + deploy correlation + resolved state ────
  router.get('/', ...adminGuards, withRoute(async ({ req, res, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);
    const items = await reportingService.listIncidents(orgId, { limit, offset });
    return sendPaginatedNested(res, 'incidents', items, {
      limit, offset, hasMore: items.length === limit,
    });
  }));

  // ── Org-admin: wiring-test dry-run (non-persisting correlation check) ────
  router.post('/test', ...adminGuards, withRoute(async ({ req, res, orgId }) => {
    const parsed = testSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }
    const environment = parsed.data.environment || 'production';
    const result = await reportingService.testIncidentCorrelation(orgId, environment);
    return sendSuccess(res, 200, { test: result });
  }));

  return router;
}
