// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess, sendBadRequest, sendError, ErrorCode,
  getParam, isServicePrincipal, isSystemAdmin,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';

/** Absolute retention ceiling (days). Mirrors reporting-service RETENTION_MAX_DAYS. */
const RETENTION_MAX_DAYS = 730;

/**
 * Normalize an inbound retention value from billing.
 *  - `-1` (unlimited) passes through untouched.
 *  - an integer in `[1, 730]` is accepted as-is.
 *  - an integer `> 730` clamps down to 730 (the absolute ceiling).
 *  - anything else (non-integer, `0`, `< -1`) is rejected → `null`.
 */
function normalizeRetentionDays(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  if (v === -1) return -1;
  if (v < 1) return null;
  return v > RETENTION_MAX_DAYS ? RETENTION_MAX_DAYS : v;
}

/**
 * Inbound billing → reporting retention sync (Phase 8).
 *
 * `PUT /:orgId` — billing pushes the account's EFFECTIVE retention entitlement
 * (tier baseline + purchased retention/dora-history bundles, already computed by
 * `effectiveEntitlements`) into reporting's `dora_settings`, so the sweep +
 * per-org query cap read the current entitlement without reporting recomputing
 * billing math.
 *
 * AUTH: identical to the platform `PUT /organization/:id/seat-limit` leg this
 * mirrors — a SERVICE PRINCIPAL or a system-admin. The billing service token
 * (`getServiceAuthHeader({ serviceName: 'billing', ... })` → `sub: service:billing`)
 * satisfies `isServicePrincipal`; it carries NO `reporting:ingest` scope and NO
 * org-user permission, so the guard must not require either. The `:orgId` path
 * param carries the target ROOT org (billing resolves the org to its root before
 * calling), mirroring platform's seat-limit route shape — NOT the token's org.
 */
export function createRetentionSyncRoutes(): Router {
  const router = Router();

  router.put('/:orgId', withRoute(async ({ req, res, ctx }) => {
    // Service-to-service entitlement sync: accept the billing service token (or a
    // sysadmin), never a plain org-user JWT. Copied verbatim from platform's
    // seat-limit route so the two internal sync legs authorize identically.
    if (!isServicePrincipal(req) && !isSystemAdmin(req)) {
      return sendError(res, 403, 'Forbidden: service or system-admin only', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const orgId = getParam(req.params, 'orgId');
    if (!orgId) return sendBadRequest(res, 'orgId path parameter is required', ErrorCode.VALIDATION_ERROR);

    const body = (req.body ?? {}) as { eventRetentionDays?: unknown; doraRetentionDays?: unknown };
    const eventRetentionDays = normalizeRetentionDays(body.eventRetentionDays);
    const doraRetentionDays = normalizeRetentionDays(body.doraRetentionDays);
    if (eventRetentionDays === null) {
      return sendBadRequest(res, 'eventRetentionDays must be -1 or an integer in [1, 730]', ErrorCode.VALIDATION_ERROR);
    }
    if (doraRetentionDays === null) {
      return sendBadRequest(res, 'doraRetentionDays must be -1 or an integer in [1, 730]', ErrorCode.VALIDATION_ERROR);
    }

    await reportingService.setReportingSettings(orgId, { eventRetentionDays, doraRetentionDays });
    ctx.log('COMPLETED', 'Synced reporting retention from billing', { orgId, eventRetentionDays, doraRetentionDays });
    return sendSuccess(res, 200, { orgId, eventRetentionDays, doraRetentionDays, ok: true });
  }, { requireOrgId: false }));

  return router;
}
