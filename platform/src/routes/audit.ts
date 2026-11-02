// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService, requirePermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { ingestAuditEvent, listAuditEvents, verifyAuditChainHandler } from '../controllers/audit.js';
import { requireAuth, requireServiceAuth } from '../middleware/index.js';

const router: Router = Router();

/** GET /audit — list audit events, org-scoped.
 *
 * `audit:read` rather than a bare admin check, so an org can delegate its own
 * trail: a compliance reviewer gets the records without being made an admin of
 * everything that produces them. It is in the admin bundle, so every existing
 * org admin keeps access unchanged.
 *
 * The permission is the AUTHORIZATION; the SCOPE is still the controller's — a
 * non-sysadmin is pinned to rows where their org is the actor or the target
 * (`orgIdOrAffected`), which no route-level gate could express. */
router.get('/', requireAuth, requirePermission('audit:read'), listAuditEvents);

/** GET /audit/verify?orgId=... - Verify a tenant's audit hash chain (sysadmin only). */
router.get('/verify', requireAuth, requirePermission('audit:read'), verifyAuditChainHandler);

/**
 * POST /audit/events — INTERNAL audit ingest for the non-platform services.
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
