// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/reports/stakeholder-internal/*` — the one call platform makes into reporting.
 *
 * A report definition names its OWNER, and a scheduled run is authorized as that
 * person. When they leave the organization, their reports have to stop: the run
 * would otherwise keep computing numbers with the access of someone who no longer
 * has any, and keep mailing them to a distribution list nobody is now accountable
 * for.
 *
 * WHY PLATFORM PUSHES INSTEAD OF REPORTING POLLING. Platform is where a member is
 * deactivated, so it is the only place that knows the moment it happened. The
 * scheduler re-checks every owner on every run anyway (that is the backstop), but
 * a weekly report would otherwise keep running for up to a week after the person
 * walked out — and an admin would find out from the recipient list, not from us.
 *
 * WHY IT RETURNS THE PAUSED REPORTS. A silently stopped weekly report is
 * discovered by a manager not receiving it. Platform takes this list and tells the
 * org's admins which reports need a new owner, which is a notification that
 * belongs where notifications already live.
 *
 * INTERNAL: platform's signed token only. Mounted at its own bare-`requireAuth`
 * prefix — there is no user, no orgId claim and no feature entitlement on this
 * call; the target org is the path parameter.
 */

import {
  ErrorCode,
  actorId,
  audited,
  recordAudit,
  requireInternalService,
  sendBadRequest,
  sendSuccess,
  getParam,
  validateBody,
  SYSTEM_ACTOR_ID,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { runWithTenantContext, stakeholderReportStore, type ReportPauseReason } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';

const bodySchema = z.object({
  /**
   * Why the owner can no longer run reports. Recorded on the definition rather
   * than inferred, because the three causes need different fixes and the lead
   * reads this string.
   */
  reason: z.enum(['owner_inactive', 'permission_lost']),
}).strict();

export function createStakeholderInternalRoutes(): Router {
  const router = Router();

  /**
   * `POST /owner-left/:orgId/:userId` — pause every definition this person owns.
   *
   * Idempotent: it only touches definitions that are still active, so a retry (or
   * a deactivate-reactivate-deactivate sequence) neither double-audits nor
   * overwrites the reason a definition was first paused.
   */
  router.post('/owner-left/:orgId/:userId',
    requireInternalService({ callers: ['platform'] }),
    audited('reporting.report.paused'),
    withRoute(async ({ req, res, ctx }) => {
      const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
      const userId = getParam(req.params, 'userId') ?? '';
      if (!orgId || !userId) return sendBadRequest(res, 'orgId and userId are required', ErrorCode.VALIDATION_ERROR);
      const validation = validateBody(req, bodySchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const reason = validation.value.reason as ReportPauseReason;

      // There is no user JWT on this call, so there is no ambient tenant scope for
      // RLS to read — it is established here from the path parameter, which the
      // internal-service gate above has already vouched for.
      const paused = await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
        stakeholderReportStore.pauseDefinitionsForOwner(orgId, userId, reason));

      ctx.log('COMPLETED', 'Paused a former member’s report definitions', { orgId, paused: paused.length, reason });
      if (paused.length > 0) {
        recordAudit({
          action: 'reporting.report.paused',
          // The actor is the platform service, not the admin who clicked
          // "deactivate" — attributing this to them would claim they decided to
          // stop these specific reports, which they did not.
          actorId: actorId({ userId: SYSTEM_ACTOR_ID }),
          orgId,
          affectedOrgId: orgId,
          targetType: 'report-definition',
          targetId: paused.map((d) => d.id).join(','),
          details: { reason, ownerId: userId, count: paused.length, names: paused.map((d) => d.name) },
        });
      }
      return sendSuccess(res, 200, {
        paused: paused.map((d) => ({ id: d.id, name: d.name, cadence: d.cadence })),
      });
    }, { requireOrgId: false }));

  return router;
}
