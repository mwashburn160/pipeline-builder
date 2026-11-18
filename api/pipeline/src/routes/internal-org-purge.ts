// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline service's org-purge cascade leg (service-to-service only).
 *
 * Platform's durable cascade outbox calls this once per purged org. The rows it
 * removes — pipelines and templates (tombstoned for the retention sweep), the
 * registry, step manifests and lookups, plugin resolutions and security reports
 * (removed) — are this service's own `pipeline` slice of pipeline-data's
 * `ORG_DATA_OWNERSHIP`, so the SQL runs here and platform never writes these
 * tables. Idempotent: a redelivery matches nothing and answers 200 again.
 *
 * Registers: POST /pipelines/internal/orgs/:orgId/purge → { orgId, tables }
 */

import { audited, contractRoute, PIPELINE_INTERNAL, requireAuth, requireInternalService } from '@pipeline-builder/api-core';
import { handleOrgDataPurge } from '@pipeline-builder/api-server';
import { Router } from 'express';

const PURGE = PIPELINE_INTERNAL.purgeOrg;

export function createInternalOrgPurgeRoutes(): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, '/pipelines/internal'),
    requireAuth,
    requireInternalService({ callers: PURGE.callers }),
    audited('org.data.purge'),
    async (req, res) => handleOrgDataPurge(req, res, { contract: PURGE, owner: 'pipeline', auditAction: 'org.data.purge' }),
  );
  return router;
}
