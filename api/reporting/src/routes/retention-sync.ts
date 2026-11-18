// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess, sendBadRequest, ErrorCode,
  requireInternalService, audited,
  actorId, contractErrorMessage, contractRoute, parseContractBody, parseContractParams, REPORTING_INTERNAL,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';

/**
 * Inbound billing → reporting retention sync.
 *
 * `PUT /:orgId` — billing pushes the account's EFFECTIVE retention entitlement
 * (tier baseline + purchased retention/dora-history bundles, already computed by
 * `effectiveEntitlements`) into reporting's `dora_settings`, so the sweep +
 * per-org query cap read the current entitlement without reporting recomputing
 * billing math.
 *
 * AUTH: an INTERNAL route — only `billing`'s own signed token passes, and the
 * name is bound to the signing key, so no other service can drive an org's
 * retention. The token carries NO `reporting:ingest` scope and NO org-user
 * permission, so the guard must not require either. There is no system-admin
 * escape hatch: an internal route refuses every user token, however privileged. The `:orgId` path param carries the target ROOT org
 * (billing resolves the org to its root before calling) — NOT the token's org.
 */
/**
 * The api-core contracts. The push body validates each retention (`-1` or an
 * integer ≥ 1, clamped to the ceiling — anything else is a 400 naming the
 * field) and keeps billing's `occurredAt` only when it is a real instant (it is
 * copied into the audit row; a bad one is dropped, never a 400).
 */
const SYNC = REPORTING_INTERNAL.syncRetention;
const READ = REPORTING_INTERNAL.readRetention;
const MOUNT = '/reports/internal/retention-sync';

export function createRetentionSyncRoutes(): Router {
  const router = Router();

  router.put(contractRoute(SYNC, MOUNT), requireInternalService({ callers: SYNC.callers }), audited('reporting.retention.sync'), withRoute(async ({ req, res, ctx, userId }) => {
    const params = parseContractParams(SYNC, req);
    if (!params.ok) return sendBadRequest(res, contractErrorMessage(params), ErrorCode.VALIDATION_ERROR);
    const { orgId } = params.value;

    const body = parseContractBody(SYNC, req);
    if (!body.ok) return sendBadRequest(res, contractErrorMessage(body), ErrorCode.VALIDATION_ERROR);
    const { eventRetentionDays, doraRetentionDays, occurredAt: billingOccurredAt } = body.value;

    // The enforced values BEFORE this push, for the audit row: a retention CUT is
    // data-destroying at the next sweep, and "cut from what" is the half nobody
    // can reconstruct once the sweep has run.
    const before = await runWithTenantContext({ orgId, isSuperAdmin: false }, () => reportingService.getReportingSettings(orgId));
    await reportingService.setReportingSettings(orgId, { eventRetentionDays, doraRetentionDays });
    ctx.log('COMPLETED', 'Synced reporting retention from billing', { orgId, eventRetentionDays, doraRetentionDays });
    // Best-effort attributed audit — the same durable trail platform's sibling
    // seat-limit sync leg writes (`admin.org.seatLimit.update`): this entitlement
    // push decides how long an org's raw reporting data is kept, so a retention
    // reduction (a data-destroying change, applied by the next sweep) must be
    // traceable to the service call that made it. `orgId` is the target
    // ROOT org; the actor is the billing service principal (the internal
    // guard admits nothing else).
    recordAudit({
      action: 'reporting.retention.sync',
      actorId: actorId({ userId }),
      // Recorded FOR the target root org (billing names it in the path).
      orgId,
      targetType: 'reporting-settings',
      targetId: orgId,
      details: {
        eventRetentionDays,
        doraRetentionDays,
        before: { eventRetentionDays: before.eventRetentionDays, doraRetentionDays: before.doraRetentionDays },
        // Billing's own instant for the entitlement change it is pushing — the
        // correlation key back to the billing_events row that caused it (the
        // request id rides the audit context).
        ...(billingOccurredAt ? { billingOccurredAt } : {}),
      },
    });
    return sendSuccess(res, 200, { orgId, eventRetentionDays, doraRetentionDays, ok: true });
  }, { requireOrgId: false }));

  // GET /:orgId — drift-read for billing's reconciler: the retention override
  // reporting is ENFORCING for the root org (`null` = none stored, the env
  // default applies). Same internal billing-only guard as the PUT; the `:orgId`
  // is the target root org, so the read runs scoped to that org explicitly.
  router.get(contractRoute(READ, MOUNT), requireInternalService({ callers: READ.callers }), withRoute(async ({ req, res }) => {
    const params = parseContractParams(READ, req);
    if (!params.ok) return sendBadRequest(res, contractErrorMessage(params), ErrorCode.VALIDATION_ERROR);
    const { orgId } = params.value;
    const settings = await runWithTenantContext({ orgId, isSuperAdmin: false }, () => reportingService.getReportingSettings(orgId));
    return sendSuccess(res, 200, {
      orgId,
      eventRetentionDays: settings.eventRetentionDays,
      doraRetentionDays: settings.doraRetentionDays,
    });
  }, { requireOrgId: false }));

  return router;
}
