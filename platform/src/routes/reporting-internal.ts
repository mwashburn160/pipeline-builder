// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM_INTERNAL, contractRoute, requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getAccessPosture, getReportAuthority, getReportReaders, getRecipientCheck } from '../controllers/reporting-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/**
 * `/internal/reporting/*` — the identity facts a SCHEDULED report run needs
 * (controllers/reporting-internal.ts explains why they cannot live in the
 * reporting service). INTERNAL: only the `reporting` service's signed token
 * reaches them; the mesh policy on the Istio targets names the same caller, and
 * compose relies on this gate alone.
 */
/** Where `mount.ts` mounts this router — the contracts' paths are under it. */
export const REPORTING_INTERNAL_MOUNT = '/internal/reporting';

const {
  reportAuthority: AUTHORITY,
  reportRecipientCheck: RECIPIENT,
  reportAccessPosture: POSTURE,
  reportReaders: READERS,
} = PLATFORM_INTERNAL;

const reportingOnly = (callers: readonly string[]) => [requireServiceAuth, requireInternalService({ callers: [...callers] })];

const router: Router = Router();

/** May this owner still produce reports here, and does the account hold the add-on? */
router.get(contractRoute(AUTHORITY, REPORTING_INTERNAL_MOUNT), ...reportingOnly(AUTHORITY.callers), getReportAuthority);

/** Is this one address an active member of this org? One address, never a list. */
router.get(contractRoute(RECIPIENT, REPORTING_INTERNAL_MOUNT), ...reportingOnly(RECIPIENT.callers), getRecipientCheck);

/**
 * Who a published report's in-app notice goes to: the user ids of the members holding
 * `reports:read`. Ids only, capped, and the token must be scoped to the path org.
 */
router.get(contractRoute(READERS, REPORTING_INTERNAL_MOUNT), ...reportingOnly(READERS.callers), getReportReaders);

/**
 * The access half of a report's posture panel: members, second-factor coverage, SSO,
 * service accounts, live API keys, permission changes in the window. COUNTS ONLY —
 * see the controller for why naming the accounts without a factor would be a target
 * list rather than a status report.
 */
router.get(contractRoute(POSTURE, REPORTING_INTERNAL_MOUNT), ...reportingOnly(POSTURE.callers), getAccessPosture);

export default router;
