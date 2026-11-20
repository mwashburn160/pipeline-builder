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
 *  - POST /internal/plugins/orgs/:orgId/purge — platform's durable cascade
 *    outbox → tear a purged org's plugin rows (plugins, installs, policies,
 *    advisory deliveries, notification prefs, toolchain default) out of this
 *    service's own `plugin` slice, after the org's kept sources on RustFS
 *    (`plugin-sources/<orgId>/`; a failed delete there is a 500, not an ack).
 *    Idempotent; 2xx is the outbox's ack.
 *  - POST /internal/plugins/users/:userId/erase — the same outbox, for a GDPR
 *    user erasure → scrub the person out of the listing reviews they wrote
 *    (author, display name, body go NULL; the rating stays). Idempotent: the
 *    predicate is the author id, so a redelivery scrubs nothing.
 */

import {
  audited,
  contractErrorMessage,
  contractRoute,
  createLogger,
  ErrorCode,
  errorMessage,
  MAX_REFERENCE_DIGESTS,
  parseContractParams,
  parseContractQuery,
  PLUGIN_INTERNAL,
  recordAudit,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  splitReferenceDigests,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { handleOrgDataPurge, withRoute } from '@pipeline-builder/api-server';
import { anonymizeReviewsByAuthor, distinctPipelines, findVersionReferences, orgImageDigestsInUse, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { Router, type RequestHandler } from 'express';

import { plugins } from '../services/ecosystem/store.js';
import { deleteOrgSources } from '../services/plugin-sources.js';

/** Digests one image-pipeline-references read may ask about (the contract's cap). */
export { MAX_REFERENCE_DIGESTS };
/** Pipelines named per digest; the count is always exact. */
const MAX_NAMED_PIPELINES = 50;

/** The endpoints this router serves, defined once in api-core. */
const C = PLUGIN_INTERNAL;
const MOUNT = '/internal';

const logger = createLogger('plugin-internal');

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

  router.post(
    contractRoute(C.purgeOrg, MOUNT),
    requireInternalService({ callers: [...C.purgeOrg.callers] }) as RequestHandler,
    audited('org.data.purge'),
    (async (req, res) => {
      // The org's kept plugin sources (plugin-sources/<orgId>/) go FIRST, and a
      // failure is not an ack: the table purge below drops the org's
      // plugin_source_orphans rows, so nothing else would ever retry them.
      const p = parseContractParams(C.purgeOrg, req);
      if (p.ok) {
        try {
          await deleteOrgSources(String(p.value.orgId));
        } catch (err) {
          logger.warn('Org purge: kept plugin sources not deleted; the leg will be retried', { orgId: p.value.orgId, error: errorMessage(err) });
          return sendError(res, 500, 'Org plugin sources purge failed', ErrorCode.INTERNAL_ERROR);
        }
      }
      return handleOrgDataPurge(req, res, { contract: C.purgeOrg, owner: 'plugin', auditAction: 'org.data.purge' });
    }) as RequestHandler,
  );

  router.post(
    contractRoute(C.eraseUser, MOUNT),
    requireInternalService({ callers: [...C.eraseUser.callers] }) as RequestHandler,
    audited('plugin.review.anonymize'),
    // A plain handler (no `withRoute`): there is no tenant request context to
    // build — the subject is the path's user, and every failure is answered here.
    (async (req, res) => {
      const p = parseContractParams(C.eraseUser, req);
      if (!p.ok) return sendBadRequest(res, contractErrorMessage(p), ErrorCode.MISSING_REQUIRED_FIELD);
      const { userId } = p.value;
      let reviews: number;
      try {
        // SUPERADMIN scope, required rather than convenient: reviews are RLS-scoped
        // by `authorOrgId`, and one person may have reviewed from several orgs. A
        // scrub limited to one org would be a PARTIAL erasure nothing reports.
        reviews = await runWithTenantContext({ isSuperAdmin: true }, () => anonymizeReviewsByAuthor(userId));
      } catch (err) {
        // Not an ack: platform's outbox keeps the leg pending and retries.
        logger.warn('Failed to anonymize ecosystem content for a deleted user', { userId, error: errorMessage(err) });
        return sendError(res, 500, 'User erasure failed', ErrorCode.INTERNAL_ERROR);
      }
      if (reviews > 0) {
        logger.info('Anonymized ecosystem content for a deleted user', { userId, reviews });
        // The COUNT only — never the prose removed, which would defeat the
        // erasure the row is recording. A recorder failure must not turn the
        // completed scrub into a non-ack (the outbox would redeliver forever).
        try {
          recordAudit({
            action: 'plugin.review.anonymize',
            actorId: SYSTEM_ACTOR_ID,
            orgId: SYSTEM_ORG_ID,
            targetType: 'user',
            targetId: userId,
            details: { reviews },
          });
        } catch (err) {
          logger.warn('plugin.review.anonymize audit failed', { userId, error: errorMessage(err) });
        }
      }
      return sendSuccess(res, 200, { userId, reviews });
    }) as RequestHandler,
  );

  return router;
}
