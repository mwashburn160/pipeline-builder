// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 routes (3b), mounted at `/scim/v2` — so an identity provider is
 * configured with `https://<host>/api/scim/v2` (nginx strips the `/api`).
 *
 * There is NO org id in any path: the org is the one the presenting
 * service-account key belongs to. That is the whole tenancy model here, and it
 * means a mis-copied base URL can only ever fail, never cross tenants.
 *
 * The gate chain is `requireAuth` → `requireScimScope`. Deliberately NOT a
 * `requirePermission`: the caller is a machine carrying a capability SCOPE, which
 * grants no permissions at all (see `signServiceAccountToken`), so there is no
 * permission for it to hold. The route-coverage test records the scope gate from
 * the middleware's tag and carries the matching exception.
 *
 * Body parsing is router-local because IdPs send `Content-Type:
 * application/scim+json`, which the app-wide `express.json()` (typed
 * `application/json`) does not match — without this the handlers would see an
 * empty body and answer 400 to every write.
 */

import { audited } from '@pipeline-builder/api-core';
import express, { Router } from 'express';
import { SCIM_CONTENT_TYPE } from '../constants/scim.js';
import {
  scimCreateGroup,
  scimCreateUser,
  scimDeleteGroup,
  scimDeleteUser,
  scimGetGroup,
  scimGetUser,
  scimListGroups,
  scimListUsers,
  scimPatchGroup,
  scimPatchUser,
  scimReplaceGroup,
  scimReplaceUser,
  scimResourceTypes,
  scimSchemas,
  scimServiceProviderConfig,
} from '../controllers/scim.js';
import { requireAuth } from '../middleware/index.js';
import { requireScimScope } from '../middleware/require-scim-scope.js';

const router: Router = Router();

// Accept both media types a SCIM client may send. 512kb bounds a directory push
// (the member cap in `constants/scim.ts` is the real ceiling); the app-wide
// parser's 1mb limit does not apply to a body it never matched.
router.use(express.json({ type: ['application/json', SCIM_CONTENT_TYPE], limit: '512kb' }));
router.use(requireAuth, requireScimScope);

// -- Discovery ---------------------------------------------------------------
router.get('/ServiceProviderConfig', scimServiceProviderConfig);
router.get('/ResourceTypes', scimResourceTypes);
router.get('/Schemas', scimSchemas);

// -- Users -------------------------------------------------------------------
router.get('/Users', scimListUsers);
router.get('/Users/:id', scimGetUser);
router.post('/Users', audited('org.scim.user.create', 'org.scim.refused'), scimCreateUser);
router.put('/Users/:id', audited('org.scim.user.update', 'org.scim.user.deactivate', 'org.scim.refused'), scimReplaceUser);
router.patch(
  '/Users/:id',
  audited('org.scim.user.update', 'org.scim.user.activate', 'org.scim.user.deactivate', 'org.scim.refused'),
  scimPatchUser,
);
router.delete('/Users/:id', audited('org.scim.user.delete', 'org.scim.refused'), scimDeleteUser);

// -- Groups ------------------------------------------------------------------
router.get('/Groups', scimListGroups);
router.get('/Groups/:id', scimGetGroup);
router.post('/Groups', audited('org.scim.group.create', 'org.scim.refused'), scimCreateGroup);
router.put('/Groups/:id', audited('org.scim.group.update', 'org.scim.group.members', 'org.scim.refused'), scimReplaceGroup);
router.patch('/Groups/:id', audited('org.scim.group.update', 'org.scim.group.members', 'org.scim.refused'), scimPatchGroup);
router.delete('/Groups/:id', audited('org.scim.group.delete', 'org.scim.refused'), scimDeleteGroup);

export default router;
