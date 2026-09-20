// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess, sendBadRequest, ErrorCode,
  getParam, requireInternalService, audited,
  actorId,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { emitReportingAudit } from '../services/audit.js';

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
 * AUTH: an INTERNAL route (#14) — only `billing`'s own signed token passes, and
 * the name is bound to the signing key, so no other service can drive an org's
 * retention. The token carries NO `reporting:ingest` scope and NO org-user
 * permission, so the guard must not require either. The system-admin escape
 * hatch this leg used to allow is gone: an internal route refuses every user
 * token, however privileged. The `:orgId` path param carries the target ROOT org
 * (billing resolves the org to its root before calling) — NOT the token's org.
 */
export function createRetentionSyncRoutes(): Router {
  const router = Router();

  router.put('/:orgId', requireInternalService({ callers: ['billing'] }), audited('reporting.retention.sync'), withRoute(async ({ req, res, ctx, userId }) => {
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
    // Best-effort attributed audit — the same durable trail platform's sibling
    // seat-limit sync leg writes (`admin.org.seatLimit.update`): this entitlement
    // push decides how long an org's raw reporting data is kept, so a retention
    // reduction (a data-destroying change, applied by the next sweep) must be
    // traceable to the service call that made it. `affectedOrgId` is the target
    // ROOT org; the actor is the billing service principal (or a sysadmin).
    emitReportingAudit({
      action: 'reporting.retention.sync',
      actorId: actorId({ userId }),
      affectedOrgId: orgId,
      targetType: 'reporting-settings',
      targetId: orgId,
      details: { eventRetentionDays, doraRetentionDays },
    });
    return sendSuccess(res, 200, { orgId, eventRetentionDays, doraRetentionDays, ok: true });
  }, { requireOrgId: false }));

  return router;
}
