// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Kept setup images (services/kept-setup-images.ts): gate-refused images from
 * the setup catalog load, kept for promotion without a rebuild. SYSTEM-ORG
 * routes (system org + `plugins:moderate` + an aal2 session), mounted at
 * `/plugins` behind the shared auth + org chain, before the read routes so
 * `/:id` never sees them:
 *
 *   GET  /plugins/kept-setup-images              the kept images, oldest first
 *   POST /plugins/kept-setup-images/:id/promote  re-gate with the CURRENT rules; store the version if it passes
 */

import { audited, requireSystemOrgPermission, sendSuccess } from '@pipeline-builder/api-core';
import { Router, type RequestHandler } from 'express';

import { ecosystemRoute, param } from './ecosystem-route.js';
import { listKeptSetupImages, promoteKeptSetupImage } from '../services/kept-setup-images.js';

/** The kept-setup-image routes (mounted at `/plugins`). */
export function createKeptSetupImageRoutes(): Router {
  const router = Router();
  const moderate = requireSystemOrgPermission('plugins:moderate');

  router.get('/kept-setup-images', ...moderate, ecosystemRoute(async ({ res, caller }) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, { images: await listKeptSetupImages(caller.orgId) });
  }));

  router.post('/kept-setup-images/:id/promote', ...moderate,
    audited('plugin.setup_image.promoted', 'plugin.setup_image.promote_refused') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      const result = await promoteKeptSetupImage(param(req, 'id'), { orgId: caller.orgId, userId: caller.userId });
      sendSuccess(res, 201, result, 'Kept setup image promoted');
    }));

  return router;
}
