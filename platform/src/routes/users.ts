// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, gateWhen, requireAssurance, requirePermission, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  listAllUsers,
  getUserById,
  createUserByAdmin,
  updateUserById,
  deleteUserById,
  bulkDeleteUsers,
  updateUserFeatures,
} from '../controllers/index.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router();

// These routes are gated by `members:manage` and are DUAL-MODE: a sysadmin acts
// fleet-wide, while an org-admin is scoped to their own org (enforced in the
// controller). Create/bulk paths are further restricted to sysadmins there.
//
// Editing, deleting or re-entitling ANOTHER person's account always needs an
// `aal: 2` session — a single-factor session must not be able to take
// over or erase accounts, whatever any org's policy says.
const mfaGrade = requireAssurance({ minAssurance: 2 });

/** GET /users - List users (members:manage; sysadmin = all, org-admin = own org). */
router.get('/', requireAuth, requirePermission('members:manage'), listAllUsers);

/** POST /users - Create a user (members:manage; controller restricts to sysadmin).
 *  Creating one pre-flagged `isSuperAdmin` IS a platform-admin grant, so it
 *  carries the grant route's gates (POST /admin/users/:id/grants): an `aal: 2`
 *  session AND a second-factor step-up. Conditional (`gateWhen`), so an
 *  ordinary account stays creatable as before; the route table lists them
 *  under `conditionalGates`. */
router.post(
  '/',
  requireAuth,
  requirePermission('members:manage'),
  gateWhen(
    'creates a platform super-admin',
    (req) => (req.body as { isSuperAdmin?: unknown } | undefined)?.isSuperAdmin === true,
    mfaGrade,
    requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
  ),
  audited('admin.user.create'),
  createUserByAdmin,
);

/** GET /users/:id - Get a user (members:manage; org-admin scoped to a shared org). */
router.get('/:id', requireAuth, requirePermission('members:manage'), getUserById);

/** PUT /users/:id - Update a user (members:manage; org-admin scoped to a shared org). */
router.put('/:id', requireAuth, requirePermission('members:manage'), mfaGrade, requireStepUp, audited('admin.user.update'), updateUserById);

/** PUT /users/:id/features - Update user feature overrides (members:manage; step-up gated — a capability grant). */
router.put('/:id/features', requireAuth, requirePermission('members:manage'), mfaGrade, requireStepUp, audited('admin.user.features.update'), updateUserFeatures);

/** DELETE /users/:id - Delete user by ID (system admin only) */
router.delete('/:id', requireAuth, requirePermission('members:manage'), mfaGrade, requireStepUp, audited('admin.user.delete'), deleteUserById);

/**
 * POST /users/bulk-delete - Bulk delete users (system admin only).
 * Posted instead of DELETE because Express bodies on DELETE are flaky
 * through some proxies. Server enforces sysadmin-only and a 100-id cap.
 */
router.post('/bulk-delete', requireAuth, requirePermission('members:manage'), mfaGrade, requireStepUp, audited('admin.user.delete'), bulkDeleteUsers);

export default router;
