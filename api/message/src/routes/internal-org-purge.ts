// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendError, sendBadRequest, ErrorCode, createLogger, requireAuth, requireServicePrincipal, getParam } from '@pipeline-builder/api-core';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { attachmentService } from '../services/attachment-service.js';

const logger = createLogger('internal-org-purge');

/**
 * Internal org-purge route (service-to-service only).
 *
 * The platform org-delete cascade hard-deletes the `message_attachments`
 * metadata rows directly in postgres but holds no object-storage client, so the
 * MinIO blobs (keyed `<orgId>/…`) would orphan. This endpoint — called by the
 * cascade with a service JWT — reclaims them by org key-prefix. It is NOT
 * user-facing: `requireAuth` + `requireServicePrincipal` require a signed
 * service token (minted via `getServiceAuthHeader`), never a user session.
 *
 * Registers: DELETE /internal/org/:orgId/attachments  →  { deleted: <count> }
 */
export function createInternalOrgPurgeRoutes(): Router {
  const router = Router();

  router.delete('/internal/org/:orgId/attachments', requireAuth, requireServicePrincipal, async (req: Request, res: Response) => {
    const orgId = getParam(req.params, 'orgId');
    if (!orgId) {
      return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
    }

    try {
      const deleted = await attachmentService.purgeOrgBlobs(orgId);
      logger.info('Org attachment blobs purged', { orgId, deleted });
      return sendSuccess(res, 200, { orgId, deleted });
    } catch (err) {
      // A partial/failed purge must read as a FAILURE (non-2xx) so the cascade
      // records blob cleanup as incomplete rather than silently leaving orphans.
      logger.warn('Org attachment blob purge failed', { orgId, error: err instanceof Error ? err.message : String(err) });
      return sendError(res, 500, 'Attachment blob purge failed', ErrorCode.INTERNAL_ERROR);
    }
  });

  return router;
}
