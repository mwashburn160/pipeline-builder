// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ops-center's org-purge cascade leg (service-to-service only).
 *
 * Platform's durable cascade outbox calls this once per purged org. The rows it
 * removes — dashboards, alert rules and alert destinations (tombstoned, so the
 * retention sweep hard-removes them) and the destinations' delivery status
 * (removed) — are this service's own `ops-center` slice of pipeline-data's
 * `ORG_DATA_OWNERSHIP`. Idempotent: a redelivery matches nothing and answers
 * 200 again.
 *
 * Registers: POST /ops/internal/orgs/:orgId/purge → { orgId, tables }
 */

import { audited, contractRoute, OPS_CENTER_INTERNAL, requireAuth, requireInternalService } from '@pipeline-builder/api-core';
import { handleOrgDataPurge } from '@pipeline-builder/api-server';
import { Router } from 'express';

const PURGE = OPS_CENTER_INTERNAL.purgeOrg;

/** Where `app-routes.ts` mounts this router — the contract's path is under it. */
export const OPS_INTERNAL_MOUNT = '/ops/internal';

export function createInternalOrgPurgeRoutes(): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, OPS_INTERNAL_MOUNT),
    requireAuth,
    requireInternalService({ callers: PURGE.callers }),
    audited('org.data.purge'),
    async (req, res) => handleOrgDataPurge(req, res, { contract: PURGE, owner: 'ops-center', auditAction: 'org.data.purge' }),
  );
  return router;
}
