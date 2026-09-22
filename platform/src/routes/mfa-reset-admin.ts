// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin DIRECT MFA reset, mounted at `/admin/users/:id/mfa-reset`.
 *
 * The single-person path, for an org that has no second owner/admin to approve
 * a two-person request (`/organization/:id/mfa-resets`). A sysadmin with an
 * `aal: 2` session, a step-up earned with a SECOND FACTOR, and a stated reason
 * removes the member's factors and recovery codes, ends every session and grants
 * the per-user enrolment grace. Audited as `auth.mfa.direct_reset` with
 * `details.direct: true`, so it reads as what it is.
 */

import { audited, requireAssurance, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { directMfaReset } from '../controllers/mfa-reset.js';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

router.post(
  '/',
  requireAuth,
  requireSystemAdmin,
  requireAssurance({ minAssurance: 2 }),
  requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
  audited('auth.mfa.direct_reset'),
  directMfaReset,
);

export default router;
