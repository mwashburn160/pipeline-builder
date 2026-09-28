// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Inbound billing → reporting Stakeholder Reports entitlement sync.
 *
 * `PUT /:orgId` — billing pushes whether the ACCOUNT still holds the add-on. Losing it
 * pauses every report in the account with `paused_reason='entitlement'`; regaining it
 * resumes exactly those, with a freshly derived schedule.
 *
 * WHAT THIS LEG IS FOR IS IMMEDIACY, NOT SAFETY. Every scheduled run already re-checks
 * the entitlement against platform and pauses itself if it is gone (see
 * `report-scheduler.ts`), so a push that never arrives delays enforcement to the next
 * run rather than defeating it. What the push buys is that a customer who cancels on
 * Monday does not get one more report on Tuesday, and — the part the recheck cannot do —
 * that no new share link or delivery goes out in between.
 *
 * IT COVERS THE WHOLE ACCOUNT, not one org. Entitlement is pooled at the account root,
 * but report definitions live in whichever org created them — including teams under the
 * root. Pausing only the org billing named would leave every team's reports running on a
 * cancelled subscription, which is the revenue leak version of this bug. The rollup is
 * resolved through platform, and a failure to resolve it is a REFUSAL rather than a
 * partial apply: half-pausing an account is worse than retrying.
 *
 * AUTH: an INTERNAL route — only `billing`'s own signed token passes, and the service
 * name is bound to the signing key. No user token qualifies, however privileged, and the
 * `:orgId` path param carries the account root billing resolved, not the token's org.
 */

import {
  actorId,
  audited,
  createLogger,
  ErrorCode,
  errorMessage,
  getParam,
  recordAudit,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { runWithTenantContext, stakeholderReportStore, type ReportDefinition } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { resolveOrgRollup } from '../helpers/report-helpers.js';
import { notifyPaused } from '../services/report-delivery.js';
import { nextRunFor } from '../services/report-schedule.js';

const logger = createLogger('stakeholder-sync');

export function createStakeholderSyncRoutes(): Router {
  const router: Router = Router();

  router.put('/:orgId',
    requireInternalService({ callers: ['billing'] }),
    // Two actions, because the route does two things and a reviewer asks about each
    // separately: "when did this account's reporting stop" and "when did it resume".
    audited('reporting.report.paused', 'reporting.report.resumed'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const rootOrgId = getParam(req.params, 'orgId');
      if (!rootOrgId) return sendBadRequest(res, 'orgId path parameter is required', ErrorCode.VALIDATION_ERROR);

      const body = (req.body ?? {}) as { entitled?: unknown; occurredAt?: unknown };
      if (typeof body.entitled !== 'boolean') {
        return sendBadRequest(res, 'entitled must be a boolean', ErrorCode.VALIDATION_ERROR);
      }
      const entitled = body.entitled;
      const occurredAt = typeof body.occurredAt === 'string' ? new Date(body.occurredAt) : undefined;
      if (occurredAt && Number.isNaN(occurredAt.getTime())) {
        return sendBadRequest(res, 'occurredAt must be an ISO timestamp', ErrorCode.VALIDATION_ERROR);
      }

      // `[root, ...descendants]`, or undefined when the org has no hierarchy. A THROWN
      // failure here is a refusal, not a fallback to the single org: see the header.
      let orgIds: string[];
      try {
        orgIds = (await resolveOrgRollup(rootOrgId)) ?? [rootOrgId];
      } catch (err) {
        logger.warn('Entitlement sync refused: could not resolve the account hierarchy', {
          orgId: rootOrgId, error: errorMessage(err),
        });
        return sendError(
          res, 503,
          'The organization hierarchy could not be resolved, so the entitlement change was not applied. Retry.',
          ErrorCode.SERVICE_UNAVAILABLE,
        );
      }

      const paused: ReportDefinition[] = [];
      const resumed: ReportDefinition[] = [];
      let skipped = 0;
      for (const orgId of orgIds) {
        // Per-org tenant context so RLS is the tenancy gate for each write, exactly as it
        // is for a request — the loop crosses orgs, the writes do not.
        const result = await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
          stakeholderReportStore.syncReportEntitlement(orgId, entitled, {
            ...(occurredAt ? { occurredAt } : {}),
            nextRunFor: (d) => nextRunFor(d, new Date()),
          }));
        if (result.skipped) {
          skipped += 1;
          continue;
        }
        paused.push(...result.paused);
        resumed.push(...result.resumed);
      }

      // Tell each affected lead, once per definition. A report that silently stops is
      // discovered by the manager who asks where it went; a pause that names the add-on
      // is a billing conversation somebody can actually have.
      for (const definition of paused) {
        await notifyPaused(definition, 'entitlement').catch(() => undefined);
      }

      for (const definition of paused) {
        recordAudit({
          action: 'reporting.report.paused',
          actorId: actorId({ userId }),
          orgId: definition.orgId,
          targetType: 'report-definition',
          targetId: definition.id,
          details: { reason: 'entitlement', name: definition.name, ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}) },
        });
      }
      for (const definition of resumed) {
        recordAudit({
          action: 'reporting.report.resumed',
          actorId: actorId({ userId }),
          orgId: definition.orgId,
          targetType: 'report-definition',
          targetId: definition.id,
          details: { reason: 'entitlement', name: definition.name, ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}) },
        });
      }

      ctx.log('COMPLETED', 'Applied the report entitlement sync', {
        orgId: rootOrgId, entitled, orgs: orgIds.length, paused: paused.length, resumed: resumed.length, skipped,
      });
      return sendSuccess(res, 200, {
        ok: true,
        paused: paused.length,
        resumed: resumed.length,
        // Named so billing's own logs can tell "nothing to do" from "an older push we
        // ignored", which otherwise look identical from the outside.
        staleOrgs: skipped,
      });
    }));

  return router;
}
