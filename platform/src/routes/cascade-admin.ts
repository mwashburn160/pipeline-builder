// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cascade-outbox operator routes, mounted at `/admin/cascade`.
 *
 * Gated like the org purge itself (`DELETE /organization/:id`), because the
 * redrive is the second half of that operation: it re-issues an erasure the
 * purge already committed. Both permissions are system-org-only, so neither can
 * be granted inside a tenant; `requireSystemOrgPermission` also demands an
 * `aal2` session. The listing reads `platform:read` — operational state across
 * tenants, the same posture as `/admin/summary` — while the redrive needs
 * `orgs:manage` and a step-up, and is audited `admin.cascade.redrive`.
 */

import { audited, requireStepUp, requireSystemOrgPermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { listCascade, redriveCascade } from '../controllers/cascade-admin.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router();

router.get('/', requireAuth, ...requireSystemOrgPermission('platform:read'), listCascade);
router.post('/:id/redrive', requireAuth, ...requireSystemOrgPermission('orgs:manage'), requireStepUp, audited('admin.cascade.redrive'), redriveCascade);

export default router;
