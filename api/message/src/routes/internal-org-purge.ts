// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendError, sendBadRequest, ErrorCode, createLogger, requireAuth, requireInternalService, getParam, errorMessage, audited, recordAudit, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID, type RemoteAuditEvent } from '@pipeline-builder/api-core';
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
 * user-facing: `requireAuth` + `requireInternalService` require a signed
 * service token from `platform` (the only caller), never a user session.
 *
 * Audited as `message.org.purge` with the blob COUNT (success) or as a failure:
 * platform audits the org deletion itself, but only this route knows how much
 * object storage the cascade actually reclaimed — and a failed reclaim is the
 * orphaned-data case a later erasure question turns on.
 *
 * Registers: DELETE /internal/org/:orgId/attachments  →  { deleted: <count> }
 */
/** The fixed part of a `message.org.purge` row: the system purging one org's blobs. */
function purgeAudit(orgId: string): Omit<RemoteAuditEvent, 'details'> {
  return {
    action: 'message.org.purge',
    actorId: SYSTEM_ACTOR_ID,
    orgId: SYSTEM_ORG_ID,
    affectedOrgId: orgId,
    targetType: 'organization',
    targetId: orgId,
  };
}

export function createInternalOrgPurgeRoutes(): Router {
  const router = Router();

  router.delete('/internal/org/:orgId/attachments', requireAuth, requireInternalService({ callers: ['platform'] }), audited('message.org.purge'), async (req: Request, res: Response) => {
    const orgId = getParam(req.params, 'orgId');
    if (!orgId) {
      return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
    }

    try {
      const deleted = await attachmentService.purgeOrgBlobs(orgId);
      logger.info('Org attachment blobs purged', { orgId, deleted });
      recordAudit({ ...purgeAudit(orgId), details: { blobsDeleted: deleted } });
      return sendSuccess(res, 200, { orgId, deleted });
    } catch (err) {
      // A partial/failed purge must read as a FAILURE (non-2xx) so the cascade
      // records blob cleanup as incomplete rather than silently leaving orphans.
      logger.warn('Org attachment blob purge failed', { orgId, error: errorMessage(err) });
      recordAudit({ ...purgeAudit(orgId), outcome: 'failure', details: { error: errorMessage(err) } });
      return sendError(res, 500, 'Attachment blob purge failed', ErrorCode.INTERNAL_ERROR);
    }
  });

  return router;
}
