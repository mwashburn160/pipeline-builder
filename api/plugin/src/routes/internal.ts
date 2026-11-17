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

import { ErrorCode, requireInternalService, sendBadRequest, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { distinctPipelines, findVersionReferences, orgImageDigestsInUse, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { Router, type RequestHandler } from 'express';

import { plugins } from '../services/ecosystem/store.js';

const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
/** Digests one image-pipeline-references read may ask about (the caller chunks). */
export const MAX_REFERENCE_DIGESTS = 50;
/** Pipelines named per digest; the count is always exact. */
const MAX_NAMED_PIPELINES = 50;

/** The `?digests=` list (comma-separated), deduped; null when absent, malformed or over the cap. */
function digestsQuery(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const digests = [...new Set(raw.split(','))];
  return digests.length <= MAX_REFERENCE_DIGESTS && digests.every((d) => DIGEST_PATTERN.test(d)) ? digests : null;
}

/** The `?orgId=` both routes take, lowercased; null when absent or malformed. */
function orgIdQuery(raw: unknown): string | null {
  const orgId = typeof raw === 'string' ? raw.toLowerCase() : '';
  return ORG_ID_PATTERN.test(orgId) && orgId.length <= 255 ? orgId : null;
}

export function createInternalRoutes(): Router {
  const router: Router = Router();

  router.get(
    '/plugins/public-names',
    requireInternalService({ callers: ['image-registry'] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const orgId = orgIdQuery(req.query.orgId);
      if (!orgId) return sendBadRequest(res, 'orgId is required', ErrorCode.VALIDATION_ERROR);
      return sendSuccess(res, 200, { names: await plugins.publicNames(orgId) });
    }, { requireOrgId: false }),
  );

  router.get(
    '/plugins/image-references',
    requireInternalService({ callers: ['image-registry'] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const orgId = orgIdQuery(req.query.orgId);
      if (!orgId) return sendBadRequest(res, 'orgId is required', ErrorCode.VALIDATION_ERROR);
      const digests = await runWithTenantContext({ isSuperAdmin: true }, () => orgImageDigestsInUse(orgId));
      return sendSuccess(res, 200, { digests });
    }, { requireOrgId: false }),
  );

  router.get(
    '/plugins/image-pipeline-references',
    requireInternalService({ callers: ['image-registry'] }) as RequestHandler,
    withRoute(async ({ req, res }) => {
      const digests = digestsQuery(req.query.digests);
      if (!digests) return sendBadRequest(res, `digests must be 1-${MAX_REFERENCE_DIGESTS} comma-separated sha256 digests`, ErrorCode.VALIDATION_ERROR);
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
