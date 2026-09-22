// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal (service-to-service) routes, mounted under `/internal` after
 * `requireAuth`. Each carries its own `requireInternalService` caller list.
 *
 *  - GET /internal/plugins/public-names?orgId= — image-registry → the names of
 *    an org's live `public` plugins: the only repositories of that org's
 *    namespace its TEAMS may pull (E22).
 */

import { ErrorCode, requireInternalService, sendBadRequest, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';

import { plugins } from '../services/ecosystem/store.js';

const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function createInternalRoutes(): Router {
  const router: Router = Router();

  router.get(
    '/plugins/public-names',
    requireInternalService({ callers: ['image-registry'] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const orgId = typeof req.query.orgId === 'string' ? req.query.orgId.toLowerCase() : '';
      if (!ORG_ID_PATTERN.test(orgId) || orgId.length > 255) return sendBadRequest(res, 'orgId is required', ErrorCode.VALIDATION_ERROR);
      return sendSuccess(res, 200, { names: await plugins.publicNames(orgId) });
    }, { requireOrgId: false }),
  );

  return router;
}
