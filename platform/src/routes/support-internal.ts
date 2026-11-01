// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal support-entitlement read, for the message service only.
 *
 * WHY PLATFORM ANSWERS THIS. The message service owns the support thread, so it
 * owns the moment a case is opened — but it cannot decide entitlement:
 * `supportContacts` is not a quota-service type (absent from
 * `VALID_QUOTA_TYPES`, like `seats`), and the EFFECTIVE limit is tier base plus
 * bundles, which only billing computes. Billing already syncs that onto the root
 * org alongside `seats`, so platform can answer from its own store with no
 * further hop.
 *
 * WHY A NAMED-CALLER GATE. This is an entitlement read, so it is exactly the
 * kind of endpoint that should not be readable by every service token in the
 * fleet. `requireInternalService({ callers: ['message'] })` names the one caller,
 * matching `ecosystem-internal` (plugin) and `reporting-internal` (reporting)
 * rather than the looser controller-side check the older
 * `/organization/:id/seat-usage` routes use.
 *
 * No user token is admitted: a tenant must not be able to enumerate its own
 * contact allowance here, and the UI gets that through its own gated surfaces.
 */

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getSupportEntitlement } from '../controllers/support-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

const messageOnly = [requireServiceAuth, requireInternalService({ callers: ['message'] })];

const router: Router = Router();

/**
 * May this org open a support case, and at what level?
 *
 * Returns the whole decision rather than a boolean so the caller can log WHY it
 * degraded and freeze the right `level` onto the case. The two scopes in the
 * payload are deliberate and documented on `SupportEntitlement`: the allowance
 * pools subtree-wide, ownership is own-org.
 */
router.get('/entitlement/:orgId', ...messageOnly, getSupportEntitlement);

export default router;
