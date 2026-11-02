// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal (service-to-service) routes, mounted under `/internal` after
 * `requireAuth`. Each carries its own `requireInternalService` caller list.
 *
 *  - GET /internal/plugins/public-names?orgId= — image-registry → the names of
 *    an org's live `public` plugins: the only repositories of that org's
 *    namespace its TEAMS may pull.
 *  - GET /internal/plugins/image-references?orgId= — image-registry's age GC →
 *    the image digests the org's namespace still needs (every plugin row's,
 *    deleted ones included, and every digest a pipeline of the org or its teams
 *    declares, runs or has an open deployed exposure on). The GC deletes none
 *    of them, and deletes nothing in a repository when this cannot be read.
 */

import { ErrorCode, requireInternalService, sendBadRequest, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { orgImageDigestsInUse, runWithTenantContext } from '@pipeline-builder/pipeline-data';
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

  router.get(
    '/plugins/image-references',
    requireInternalService({ callers: ['image-registry'] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const orgId = typeof req.query.orgId === 'string' ? req.query.orgId.toLowerCase() : '';
      if (!ORG_ID_PATTERN.test(orgId) || orgId.length > 255) return sendBadRequest(res, 'orgId is required', ErrorCode.VALIDATION_ERROR);
      const digests = await runWithTenantContext({ isSuperAdmin: true }, () => orgImageDigestsInUse(orgId));
      return sendSuccess(res, 200, { digests });
    }, { requireOrgId: false }),
  );

  return router;
}
