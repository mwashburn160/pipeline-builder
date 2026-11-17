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
 *  - GET /internal/plugins/image-pipeline-references?digests= — image-registry's
 *    manual purge (`DELETE /api/images/...`) → which PIPELINES still reference
 *    each image digest (declared, deployed — soft-deleted pipelines included —
 *    or an open deployed exposure; `findVersionReferences`, the rule every
 *    removal path asks). The purge refuses (409) while any does; there is no
 *    override.
 */

import {
  contractErrorMessage,
  contractRoute,
  ErrorCode,
  MAX_REFERENCE_DIGESTS,
  parseContractQuery,
  PLUGIN_INTERNAL,
  requireInternalService,
  sendBadRequest,
  sendSuccess,
  splitReferenceDigests,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { distinctPipelines, findVersionReferences, orgImageDigestsInUse, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { Router, type RequestHandler } from 'express';

import { plugins } from '../services/ecosystem/store.js';

/** Digests one image-pipeline-references read may ask about (the contract's cap). */
export { MAX_REFERENCE_DIGESTS };
/** Pipelines named per digest; the count is always exact. */
const MAX_NAMED_PIPELINES = 50;

/** The endpoints this router serves, defined once in api-core. */
const C = PLUGIN_INTERNAL;
const MOUNT = '/internal';

export function createInternalRoutes(): Router {
  const router: Router = Router();

  router.get(
    contractRoute(C.publicPluginNames, MOUNT),
    requireInternalService({ callers: [...C.publicPluginNames.callers] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const q = parseContractQuery(C.publicPluginNames, req);
      if (!q.ok) return sendBadRequest(res, contractErrorMessage(q), ErrorCode.VALIDATION_ERROR);
      const { orgId } = q.value;
      return sendSuccess(res, 200, { names: await plugins.publicNames(orgId) });
    }, { requireOrgId: false }),
  );

  router.get(
    contractRoute(C.orgImageReferences, MOUNT),
    requireInternalService({ callers: [...C.orgImageReferences.callers] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const q = parseContractQuery(C.orgImageReferences, req);
      if (!q.ok) return sendBadRequest(res, contractErrorMessage(q), ErrorCode.VALIDATION_ERROR);
      const { orgId } = q.value;
      const digests = await runWithTenantContext({ isSuperAdmin: true }, () => orgImageDigestsInUse(orgId));
      return sendSuccess(res, 200, { digests });
    }, { requireOrgId: false }),
  );

  router.get(
    contractRoute(C.imagePipelineReferences, MOUNT),
    requireInternalService({ callers: [...C.imagePipelineReferences.callers] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const q = parseContractQuery(C.imagePipelineReferences, req);
      if (!q.ok) return sendBadRequest(res, contractErrorMessage(q), ErrorCode.VALIDATION_ERROR);
      const digests = splitReferenceDigests(q.value.digests);
      // Elevated: a pipeline of ANY org holding the image counts.
      const references = await runWithTenantContext({ isSuperAdmin: true }, async () => {
        const out: Array<{ digest: string; pipelineCount: number; pipelines: Array<{ id: string; name: string | null; orgId: string; sources: string[]; deleted: boolean }> }> = [];
        for (const digest of digests) {
          const pipelines = distinctPipelines(await findVersionReferences({ pluginName: '', pluginVersion: '', imageDigest: digest }));
          if (pipelines.length === 0) continue;
          out.push({
            digest,
            pipelineCount: pipelines.length,
            pipelines: pipelines.slice(0, MAX_NAMED_PIPELINES).map((p) => ({ id: p.pipelineId, name: p.pipelineName, orgId: p.orgId, sources: p.sources, deleted: p.pipelineDeleted })),
          });
        }
        return out;
      });
      return sendSuccess(res, 200, { references });
    }, { requireOrgId: false }),
  );

  return router;
}
