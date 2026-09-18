// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { ingestAuditEvent, listAuditEvents, verifyAuditChainHandler } from '../controllers/audit.js';
import { requireAuth, requireServiceAuth, requireSystemAdmin } from '../middleware/index.js';

const router: Router = Router();

/** GET /audit - List audit events (admin only, org-scoped for org admins). */
router.get('/', requireAuth, listAuditEvents);

/** GET /audit/verify?orgId=... - Verify a tenant's audit hash chain (sysadmin only). */
router.get('/verify', requireAuth, requireSystemAdmin, verifyAuditChainHandler);

/**
 * POST /audit/events — INTERNAL audit ingest for the non-platform services (#14).
 *
 * Every service forwards its audit trail here through api-core's
 * `RemoteAuditClient`, so the caller list is the rest of the fleet; platform
 * writes its own events locally and never calls this. No user token is admitted:
 * the audit log is evidence, and a route that lets a person post arbitrary
 * entries into it is a route that lets a person fabricate that evidence.
 */
router.post('/events', requireServiceAuth, requireInternalService({
  callers: ['ask', 'billing', 'compliance', 'image-registry', 'message', 'pipeline', 'plugin', 'quota', 'reporting'],
}), ingestAuditEvent);

export default router;
