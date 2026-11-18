// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The compliance service's org-purge cascade leg (service-to-service only).
 *
 * Platform's durable cascade outbox calls this once per purged org. The rows it
 * removes — policies and rules (tombstoned for the retention sweep), rule
 * history, the audit log, exemptions, subscriptions, scans and scan schedules,
 * notification preferences and the notification log (removed) — are this
 * service's own `compliance` slice of pipeline-data's
 * `ORG_DATA_OWNERSHIP`, so the SQL runs here and platform never writes these
 * tables. Idempotent: a redelivery matches nothing and answers 200 again.
 *
 * Registers: POST /compliance/internal/orgs/:orgId/purge → { orgId, tables }
 */

import { audited, contractRoute, COMPLIANCE_INTERNAL, requireAuth, requireInternalService } from '@pipeline-builder/api-core';
import { handleOrgDataPurge } from '@pipeline-builder/api-server';
import { Router } from 'express';

const PURGE = COMPLIANCE_INTERNAL.purgeOrg;

export function createInternalOrgPurgeRoutes(): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, '/compliance/internal'),
    requireAuth,
    requireInternalService({ callers: PURGE.callers }),
    audited('org.data.purge'),
    async (req, res) => handleOrgDataPurge(req, res, { contract: PURGE, owner: 'compliance', auditAction: 'org.data.purge' }),
  );
  return router;
}
