// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM_INTERNAL, contractRoute, requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getOrgSeatActivity } from '../controllers/offers-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/**
 * `/internal/offers/*` — the membership reads the expansion-offers profile
 * needs.
 *
 * BILLING ONLY. The offers agent is purely a CALLER with no public surface of
 * its own, and it runs inside billing. The
 * mesh policy on the Istio targets names the same single caller; compose relies
 * on this gate alone.
 *
 * What it serves is the VALUE signal, which is a disqualifier rather than a
 * sales signal: an account at its seat cap whose members have not signed in is
 * a churn save, and offering it more seats is the worst available outcome.
 */
/** Where `mount.ts` mounts this router — the contract's path is under it. */
export const OFFERS_INTERNAL_MOUNT = '/internal/offers';

const { offerSeatActivity: SEAT_ACTIVITY } = PLATFORM_INTERNAL;

const router: Router = Router();

/** Seats held against members actually active in a window. */
router.get(
  contractRoute(SEAT_ACTIVITY, OFFERS_INTERNAL_MOUNT),
  requireServiceAuth,
  requireInternalService({ callers: [...SEAT_ACTIVITY.callers] }),
  getOrgSeatActivity,
);

export default router;
