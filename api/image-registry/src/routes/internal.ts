// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  audited,
  ErrorCode,
  getParam,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import express, { Router, type RequestHandler } from 'express';

import { isQuarantineRepo, repoOwnerOrgId } from './images/repo-access.js';
import { registerPublicationRoutes } from './internal-publications.js';
import { emitImageRegistryAudit } from '../services/audit.js';
import {
  isPluginRepository, isPublicRepository, isQuarantineRepository, isSha256Digest, PluginSigningError, signPluginImage,
} from '../services/plugin-signing.js';
import { isQuarantineSubmissionId, mintQuarantineCredential } from '../services/quarantine-credential.js';
import { headManifest } from '../services/registry-client.js';
import { deleteQuarantineRepository, QUARANTINE_PREFIX } from '../services/registry-gc.js';

/** Path of the signing route — also excluded from the app's global 1mb JSON parser. */
export const PLUGIN_SIGNATURES_PATH = '/internal/plugin-signatures';

/** Base path (under `/internal`) of the quarantine-namespace delete hook. */
export const QUARANTINE_PATH = '/quarantine';

/**
 * An SPDX document for a large image (thousands of packages) runs to several MB;
 * this route parses its own body with a limit sized for that, instead of the
 * app-wide 1mb.
 */
const SBOM_BODY_LIMIT = '32mb';

/**
 * Internal (service-to-service) routes. Mounted after `requireAuth`.
 *
 *  - POST /internal/plugin-signatures — plugin → sign a pushed plugin image
 *    digest and attach its SBOM as a signed attestation.
 *  - /internal/plugin-publications* — plugin → the public namespace
 *    (publish / resign / yank / gc / verify); see internal-publications.ts.
 *  - DELETE /internal/quarantine/:submissionId — plugin → drop an anonymous
 *    submission's quarantined build (`quarantine/<submissionId>`) once it is
 *    decided or expired.
 *  - POST /internal/quarantine/:submissionId/credential — plugin → the
 *    registry-only credential that submission's build pushes with (E21).
 */
export function createInternalRoutes(): Router {
  const router: Router = Router();

  router.post(
    '/plugin-signatures',
    // Only the plugin build worker asks for signatures — never a user token,
    // however privileged (the key is what synth trusts). Gated BEFORE the large
    // body is parsed, so no other caller can make this route buffer 32mb.
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    audited('registry.image.sign') as RequestHandler,
    express.json({ limit: SBOM_BODY_LIMIT }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const { repository, digest, sbom } = (req.body ?? {}) as { repository?: unknown; digest?: unknown; sbom?: unknown };
      // `public/*` is signed only by the publish/resign routes (fresh, annotated).
      // `quarantine/<submissionId>` is signed so its SBOM attestation survives into
      // the approved public copy; it is owned by the system org (repoOwnerOrgId).
      if (typeof repository !== 'string' || !isPluginRepository(repository) || isPublicRepository(repository)
        || (isQuarantineRepo(repository) && !isQuarantineRepository(repository))) {
        return sendBadRequest(res, 'repository must be system/<name>, org-<orgId>/<name> or quarantine/<submissionId>', ErrorCode.VALIDATION_ERROR);
      }
      if (typeof digest !== 'string' || !isSha256Digest(digest)) {
        return sendBadRequest(res, 'digest must be sha256:<64 hex>', ErrorCode.VALIDATION_ERROR);
      }
      if (!sbom || typeof sbom !== 'object' || Array.isArray(sbom) || typeof (sbom as { spdxVersion?: unknown }).spdxVersion !== 'string') {
        return sendBadRequest(res, 'sbom must be an SPDX JSON document', ErrorCode.VALIDATION_ERROR);
      }

      // The plugin service mints its token for the org whose build this is — it
      // may only get that org's images signed (the system org owns `system/*`).
      const ownerOrgId = repoOwnerOrgId(repository);
      const callerOrgId = req.user?.organizationId?.toLowerCase();
      if (!ownerOrgId || ownerOrgId !== callerOrgId) {
        return sendError(res, 403, `Forbidden: repo "${repository}" is not owned by the requesting org.`, ErrorCode.ORG_MISMATCH);
      }

      // Sign only what is actually in the registry, in THIS repository.
      if (!await headManifest(repository, digest)) {
        return sendError(res, 404, `No manifest ${digest} in ${repository}`, ErrorCode.NOT_FOUND);
      }

      try {
        await signPluginImage({ repository, digest, sbom: sbom as Record<string, unknown> });
      } catch (err) {
        if (err instanceof PluginSigningError) {
          ctx.log('ERROR', 'Plugin image signing failed', { repository, digest, error: err.message });
          return sendError(res, 502, err.message, ErrorCode.SERVICE_UNAVAILABLE);
        }
        throw err;
      }

      ctx.log('COMPLETED', 'Signed plugin image', { repository, digest });
      emitImageRegistryAudit({
        action: 'registry.image.sign',
        actorId: actorId({}),
        orgId: ownerOrgId,
        affectedOrgId: ownerOrgId,
        outcome: 'success',
        targetType: 'registry-image',
        targetId: repository,
        details: { repo: repository, digest, sbom: 'spdx-json' },
      });
      return sendSuccess(res, 200, { repository, digest, signed: true });
    }),
  );

  // Anonymous plugin submissions (plugin ecosystem §4.2 / W5): the plugin
  // service's hook for a submission that reached a terminal state (rejected,
  // gate_failed, expired, or approved once the publish copied it out). Deletes
  // every manifest in `quarantine/<submissionId>`; idempotent (a gone repo →
  // `deleted: 0`). The 30-day age sweep (startQuarantineGcScheduler) is the
  // backstop. Audited as `registry.gc` — a destructive namespace prune.
  router.delete(
    `${QUARANTINE_PATH}/:submissionId`,
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    audited('registry.gc') as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const submissionId = getParam(req.params, 'submissionId');
      const repository = `${QUARANTINE_PREFIX}${submissionId ?? ''}`;
      if (!submissionId || !isQuarantineRepository(repository)) {
        return sendBadRequest(res, 'submissionId must be one lowercase path component (the submission id)', ErrorCode.VALIDATION_ERROR);
      }
      // Moderation state is the system org's: the plugin mints this call's token for it.
      if (req.user?.organizationId?.toLowerCase() !== SYSTEM_ORG_ID) {
        return sendError(res, 403, 'Forbidden: quarantine repositories are managed under the system org.', ErrorCode.ORG_MISMATCH);
      }
      const result = await deleteQuarantineRepository(repository, 'requested');
      ctx.log('COMPLETED', 'Deleted quarantine repository', { repository, deleted: result.deleted });
      if (result.deleted > 0) {
        emitImageRegistryAudit({
          action: 'registry.gc',
          actorId: actorId({}),
          orgId: SYSTEM_ORG_ID,
          affectedOrgId: SYSTEM_ORG_ID,
          outcome: 'success',
          targetType: 'registry-namespace',
          targetId: repository,
          details: { prefix: QUARANTINE_PREFIX, repo: repository, manifestsDeleted: result.deleted, reason: 'requested' },
        });
      }
      return sendSuccess(res, 200, result);
    }),
  );

  // The credential an anonymous submission's build runs with (E21): push/pull on
  // `quarantine/<submissionId>` only, accepted by no platform service. Minting
  // one changes no durable state (it expires on its own; the token endpoint
  // re-checks it on every use) — see the route-coverage waiver.
  router.post(
    `${QUARANTINE_PATH}/:submissionId/credential`,
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const submissionId = getParam(req.params, 'submissionId');
      if (!submissionId || !isQuarantineSubmissionId(submissionId)) {
        return sendBadRequest(res, 'submissionId must be one lowercase path component (the submission id)', ErrorCode.VALIDATION_ERROR);
      }
      if (req.user?.organizationId?.toLowerCase() !== SYSTEM_ORG_ID) {
        return sendError(res, 403, 'Forbidden: quarantine repositories are managed under the system org.', ErrorCode.ORG_MISMATCH);
      }
      const ttlSeconds = Number((req.body as { ttlSeconds?: unknown } | undefined)?.ttlSeconds ?? 0);
      const credential = await mintQuarantineCredential(submissionId, ttlSeconds);
      ctx.log('COMPLETED', 'Minted quarantine build credential', { submissionId, expiresAt: credential.expiresAt });
      return sendSuccess(res, 200, credential);
    }),
  );

  registerPublicationRoutes(router);

  return router;
}
