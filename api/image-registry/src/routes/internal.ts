// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  audited,
  ErrorCode,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import express, { Router, type RequestHandler } from 'express';

import { repoOwnerOrgId } from './images/repo-access.js';
import { emitImageRegistryAudit } from '../services/audit.js';
import { isPluginRepository, isSha256Digest, PluginSigningError, signPluginImage } from '../services/plugin-signing.js';
import { headManifest } from '../services/registry-client.js';

/** Path of the signing route — also excluded from the app's global 1mb JSON parser. */
export const PLUGIN_SIGNATURES_PATH = '/internal/plugin-signatures';

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
      if (typeof repository !== 'string' || !isPluginRepository(repository)) {
        return sendBadRequest(res, 'repository must be system/<name> or org-<orgId>/<name>', ErrorCode.VALIDATION_ERROR);
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

  return router;
}
