// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode, validateBody, requirePermission } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';

/**
 * Per-org reporting configuration (Phase 5b + 7). Mounted under `/reports/settings`
 * with the DORA read gate (`reports:read` + `advanced_reporting`); the WRITE adds
 * an org-admin permission per-route.
 *
 * `GET  /incidents` — read the org's incident correlation-window override + the two
 *                     retention overrides (each with its env default when unset).
 *                     Readable by any `reports:read` holder with `advanced_reporting`.
 * `PUT  /incidents` — set the incident→deploy correlation window `incidentWindowHours`
 *                     (org-admin only). Idempotent upsert; changing it drops the
 *                     org's cached DORA reports.
 *
 * RETENTION IS BILLING-OWNED (D3): `eventRetentionDays`/`doraRetentionDays` are NOT
 * editable here — they are written ONLY by the billing→reporting `retention-sync`
 * leg (the account's effective tier baseline + purchased retention/DORA-history
 * bundles). Admitting them on this admin route was an entitlement bypass; the body
 * schema rejects them (`.strict()`). `getIncidentSettings` still RETURNS retention
 * for read-only display + the "buy a retention pack" upsell.
 *
 * Reports hard-cap at 730 days regardless (the absolute ceiling), so retention only
 * governs how far back raw source rows are preserved, never widens a single report.
 */
const reportingSettingsSchema = z.object({
  // The per-org incident→deploy correlation window in hours (1..720 = 30 days).
  incidentWindowHours: z.number().int().min(1).max(720),
}).strict();

export function createReportSettingsRoutes(): Router {
  const router = Router();

  router.get('/incidents', withRoute(async ({ res, ctx, orgId }) => {
    const settings = await reportingService.getIncidentSettings(orgId);
    ctx.log('COMPLETED', 'Read reporting settings', {
      hasWindowOverride: settings.incidentWindowHours != null,
      hasRetentionOverride: settings.eventRetentionDays != null || settings.doraRetentionDays != null,
    });
    return sendSuccess(res, 200, { settings });
  }));

  // Org-admin write: `org:settings` is the conventional org-admin config
  // permission (Member lacks it; Admin/Owner carry it), matching the sibling
  // per-org config surfaces (SSO, notification preferences).
  router.put('/incidents', requirePermission('org:settings'), withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, reportingSettingsSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    await reportingService.setReportingSettings(orgId, validation.value);
    const settings = await reportingService.getIncidentSettings(orgId);
    ctx.log('COMPLETED', 'Updated reporting settings', { orgId, ...validation.value });
    return sendSuccess(res, 200, { settings });
  }));

  return router;
}
