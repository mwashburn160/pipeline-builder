// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getOrgSeatActivity } from '../controllers/offers-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/**
 * `/internal/offers/*` — the membership reads the expansion-offers profile
 * needs (docs/plans/sales-agent.md D4 Class 3, Phase 0).
 *
 * BILLING ONLY. D13 makes the offers agent purely a CALLER with no public
 * surface of its own, and it runs inside billing until Phase 5 extracts it. The
 * mesh policy on the Istio targets names the same single caller; compose relies
 * on this gate alone.
 *
 * What it serves is the VALUE signal, which is a disqualifier rather than a
 * sales signal: an account at its seat cap whose members have not signed in is
 * a churn save, and offering it more seats is the worst available outcome.
 */
const offersCallers = [requireServiceAuth, requireInternalService({ callers: ['billing'] })];

const router: Router = Router();

/** Seats held against members actually active in a window. */
router.get('/seat-activity/:orgId', ...offersCallers, getOrgSeatActivity);

export default router;
