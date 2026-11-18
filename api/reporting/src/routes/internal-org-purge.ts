// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reporting service's org-purge cascade leg (service-to-service only).
 *
 * Platform's durable cascade outbox calls this once per purged org. The rows it
 * removes — report definitions, runs and recipients (tombstoned, so published
 * runs keep the retention window), share links, ingested events, DORA
 * outcomes/incidents/settings, ingest health and the analytics rollups
 * (removed) — are this service's own `reporting` slice of pipeline-data's
 * `ORG_DATA_OWNERSHIP`, so the SQL runs here and platform never writes these
 * tables. Idempotent: a redelivery matches nothing and answers 200 again.
 *
 * Registers: POST /reports/internal/orgs/:orgId/purge → { orgId, tables }
 */

import { audited, contractRoute, REPORTING_INTERNAL, requireAuth, requireInternalService } from '@pipeline-builder/api-core';
import { handleOrgDataPurge } from '@pipeline-builder/api-server';
import { Router } from 'express';

const PURGE = REPORTING_INTERNAL.purgeOrg;

export function createInternalOrgPurgeRoutes(): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, '/reports/internal'),
    requireAuth,
    requireInternalService({ callers: PURGE.callers }),
    audited('org.data.purge'),
    async (req, res) => handleOrgDataPurge(req, res, { contract: PURGE, owner: 'reporting', auditAction: 'org.data.purge' }),
  );
  return router;
}
