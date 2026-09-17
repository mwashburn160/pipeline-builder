// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { ingestAuditEvent, listAuditEvents, verifyAuditChainHandler } from '../controllers/audit.js';
import { requireAuth, requireServiceAuth } from '../middleware/index.js';

const router: Router = Router();

/** GET /audit - List audit events (admin only, org-scoped for org admins). */
router.get('/', requireAuth, listAuditEvents);

/** GET /audit/verify?orgId=... - Verify a tenant's audit hash chain (sysadmin only). */
router.get('/verify', requireAuth, verifyAuditChainHandler);

/** POST /audit/events - Internal ingest for non-platform services (service token only). */
router.post('/events', requireServiceAuth, ingestAuditEvent);

export default router;
