// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getAccessPosture, getReportAuthority, getRecipientCheck } from '../controllers/reporting-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/**
 * `/internal/reporting/*` — the identity facts a SCHEDULED report run needs
 * (controllers/reporting-internal.ts explains why they cannot live in the
 * reporting service). INTERNAL: only the `reporting` service's signed token
 * reaches them; the mesh policy on the Istio targets names the same caller, and
 * compose relies on this gate alone.
 */
const reportingOnly = [requireServiceAuth, requireInternalService({ callers: ['reporting'] })];

const router: Router = Router();

/** May this owner still produce reports here, and does the account hold the add-on? */
router.get('/report-authority/:orgId/:userId', ...reportingOnly, getReportAuthority);

/** Is this one address an active member of this org? One address, never a list. */
router.get('/recipient-check/:orgId', ...reportingOnly, getRecipientCheck);

/**
 * The access half of a report's posture panel: members, second-factor coverage, SSO,
 * service accounts, live API keys, permission changes in the window. COUNTS ONLY —
 * see the controller for why naming the accounts without a factor would be a target
 * list rather than a status report.
 */
router.get('/access-posture/:orgId', ...reportingOnly, getAccessPosture);

export default router;
