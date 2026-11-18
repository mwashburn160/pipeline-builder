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
  contractRoute,
  QUOTA_INTERNAL,
  requireAuth,
  requireInternalService,
} from '@pipeline-builder/api-core';
import { handleOrgDataPurge } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { QuotaService, quotaService as defaultQuotaService } from '../services/quota-service.js';

const PURGE = QUOTA_INTERNAL.purgeOrg;

/** Where `app-routes.ts` mounts this router — the contract's path is under it. */
export const QUOTA_MOUNT = '/quotas';

export function createInternalOrgPurgeRoutes(svc: QuotaService = defaultQuotaService): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, QUOTA_MOUNT),
    requireAuth as RequestHandler,
    requireInternalService({ callers: PURGE.callers }) as RequestHandler,
    audited('org.data.purge'),
    async (req, res) => handleOrgDataPurge(req, res, {
      contract: PURGE,
      service: 'quota',
      purge: async (orgId) => ({ tables: await svc.purgeOrg(orgId) }),
      auditAction: 'org.data.purge',
    }),
  );
  return router;
}
