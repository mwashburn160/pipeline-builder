// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * quota's org-purge cascade leg (service-to-service only).
 *
 * Platform's durable cascade outbox calls this once per purged org to drop
 * everything quota holds for it: the quota document (its enforcement record),
 * its notice settings and sent notices, and its usage ledger. There is deliberately no USER
 * route that does this: `quotaService.update()` and `.resetUsage()` both refuse
 * a missing document and never upsert, so dropping a live org's row would leave
 * it unenforceable and unrepairable from the dashboard. Only platform, which
 * alone decides an org is purged, may ask.
 *
 * Idempotent: `tables` counts the rows removed per collection — all zero when
 * the org was already gone — both 200. Every delete is keyed on the org id, so a
 * store failure part-way is a 500 and the leg's retry finishes the job.
 *
 * Registers: POST /quotas/internal/orgs/:orgId/purge → { orgId, tables }
 */

import {
  audited,
  contractErrorMessage,
  contractRoute,
  createLogger,
  ErrorCode,
  errorMessage,
  parseContractParams,
  QUOTA_INTERNAL,
  recordAudit,
  requireAuth,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { QuotaService, quotaService as defaultQuotaService } from '../services/quota-service.js';

const logger = createLogger('quota-internal-org-purge');

const PURGE = QUOTA_INTERNAL.purgeOrg;

/** Where `app-routes.ts` mounts this router — the contract's path is under it. */
export const QUOTA_MOUNT = '/quotas';

/** Audit, never throw: a throwing recorder must not turn an ack into a 500. */
function safeAudit(event: Parameters<typeof recordAudit>[0]): void {
  try {
    recordAudit(event);
  } catch (err) {
    logger.warn('Org purge audit failed', { error: errorMessage(err) });
  }
}

export function createInternalOrgPurgeRoutes(svc: QuotaService = defaultQuotaService): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, QUOTA_MOUNT),
    requireAuth as RequestHandler,
    requireInternalService({ callers: PURGE.callers }) as RequestHandler,
    audited('org.data.purge'),
    async (req: Request, res: Response) => {
      const params = parseContractParams(PURGE, req);
      if (!params.ok) return sendBadRequest(res, contractErrorMessage(params), ErrorCode.MISSING_REQUIRED_FIELD);
      const orgId = String((params.value as { orgId: string }).orgId);
      const audit = {
        action: 'org.data.purge',
        actorId: SYSTEM_ACTOR_ID,
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: orgId,
        targetType: 'organization',
        targetId: orgId,
      } as const;

      try {
        const tables = await svc.purgeOrg(orgId);
        safeAudit({ ...audit, details: { owner: 'quota', tables } });
        return sendSuccess(res, 200, { orgId, tables });
      } catch (err) {
        logger.warn('Org quota purge failed', { orgId, error: errorMessage(err) });
        safeAudit({ ...audit, outcome: 'failure', details: { owner: 'quota', error: errorMessage(err) } });
        return sendError(res, 500, 'Org quota purge failed', ErrorCode.INTERNAL_ERROR);
      }
    },
  );
  return router;
}
