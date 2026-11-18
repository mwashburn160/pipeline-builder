// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { MESSAGE_INTERNAL, contractRoute, sendSuccess, sendError, sendBadRequest, ErrorCode, createLogger, requireAuth, requireInternalService, getParam, errorMessage, audited, recordAudit, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID, type RemoteAuditEvent } from '@pipeline-builder/api-core';
import { handleOrgDataPurge } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { attachmentService } from '../services/attachment-service.js';

const logger = createLogger('internal-org-purge');

/**
 * Internal org-purge route (service-to-service only).
 *
 * Platform holds no object-storage client, so a purged org's MinIO blobs (keyed
 * `<orgId>/…`) would orphan without this endpoint — platform's cascade outbox
 * calls it (its `message-blobs` leg, with a service JWT, retried until it acks)
 * to reclaim them by org key-prefix. The `message_attachments` METADATA rows go
 * with the org-data leg below. It is NOT
 * user-facing: `requireAuth` + `requireInternalService` require a signed
 * service token from `platform` (the only caller), never a user session.
 *
 * Audited as `message.org.purge` with the blob COUNT (success) or as a failure:
 * platform audits the org deletion itself, but only this route knows how much
 * object storage the cascade actually reclaimed — and a failed reclaim is the
 * orphaned-data case a later erasure question turns on.
 *
 * Registers: DELETE /internal/org/:orgId/attachments  →  { deleted: <count> }
 *
 * Plus the message service's org-DATA purge leg, delivered by platform's
 * durable cascade outbox: messages and support cases (tombstoned for the
 * retention sweep), attachment metadata, case counters and staff notes
 * (removed) — this service's own `message` slice of pipeline-data's
 * `ORG_DATA_OWNERSHIP`, so platform never writes these tables. Idempotent.
 *
 * Registers: POST /internal/orgs/:orgId/purge  →  { orgId, tables }
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

/** The route and its callers — defined once in api-core. */
const PURGE = MESSAGE_INTERNAL.purgeOrgAttachments;
const PURGE_DATA = MESSAGE_INTERNAL.purgeOrgData;

export function createInternalOrgPurgeRoutes(): Router {
  const router = Router();

  router.delete(contractRoute(PURGE, '/messages'), requireAuth, requireInternalService({ callers: PURGE.callers }), audited('message.org.purge'), async (req: Request, res: Response) => {
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

  router.post(
    contractRoute(PURGE_DATA, '/messages'),
    requireAuth,
    requireInternalService({ callers: PURGE_DATA.callers }),
    audited('org.data.purge'),
    async (req: Request, res: Response) => handleOrgDataPurge(req, res, { contract: PURGE_DATA, owner: 'message', auditAction: 'org.data.purge' }),
  );

  return router;
}
