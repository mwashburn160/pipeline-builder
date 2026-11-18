// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared body of every owning service's org-purge cascade leg.
 *
 * Platform's durable outbox (`cascade_outbox`) delivers one leg per owning
 * service when an org is purged. Each service mounts its own contract
 * (`PIPELINE_INTERNAL.purgeOrg`, `COMPLIANCE_INTERNAL.purgeOrg`, …) behind its
 * own `requireAuth` + `requireInternalService` + `audited(...)` chain, and hands
 * the request here with ITS owner key, so the SQL that removes a service's rows
 * runs in that service, against its own tables — never in platform.
 *
 * The answer is the outbox's ack: 2xx only when every table of the slice was
 * torn down. `purgeOrgData` is idempotent, so a redelivered leg matches nothing
 * and answers 2xx again; any failed table answers 500 and the leg is retried
 * with backoff.
 */

import {
  contractErrorMessage,
  createLogger,
  ErrorCode,
  errorMessage,
  parseContractParams,
  recordAudit,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
  type InternalEndpointContract,
  type RemoteAuditAction,
} from '@pipeline-builder/api-core';
import { purgeOrgData, purgeRowCounts, type OrgDataOwner } from '@pipeline-builder/pipeline-data';
import type { Request, Response } from 'express';

const logger = createLogger('org-data-purge');

/**
 * Audit, never throw: the purge has already happened (or failed) by the time
 * the row is written, and a throwing recorder must not turn an ack into a 500
 * (the outbox would redeliver forever) or a failure into an unhandled rejection.
 */
function safeAudit(event: Parameters<typeof recordAudit>[0]): void {
  try {
    recordAudit(event);
  } catch (err) {
    logger.warn('Org data purge audit failed', { action: event.action, error: errorMessage(err) });
  }
}

/** What one service's purge leg needs to know about itself. */
export interface OrgDataPurgeOptions {
  /** The contract the route is mounted at (its `:orgId` param is read). */
  contract: InternalEndpointContract;
  /** Whose slice of `ORG_DATA_OWNERSHIP` this service tears down. */
  owner: OrgDataOwner;
  /** The audit action the service declares on the route (`audited(...)`). */
  auditAction: RemoteAuditAction;
}

/**
 * Parse `:orgId`, purge `owner`'s rows for it, audit the counts (or the
 * failure) and answer the outbox. Never throws.
 */
export async function handleOrgDataPurge(req: Request, res: Response, opts: OrgDataPurgeOptions): Promise<void> {
  const params = parseContractParams(opts.contract, req);
  if (!params.ok) {
    sendBadRequest(res, contractErrorMessage(params), ErrorCode.MISSING_REQUIRED_FIELD);
    return;
  }
  const orgId = String((params.value as { orgId: string }).orgId);
  const audit = {
    action: opts.auditAction,
    actorId: SYSTEM_ACTOR_ID,
    orgId: SYSTEM_ORG_ID,
    affectedOrgId: orgId,
    targetType: 'organization',
    targetId: orgId,
  } as const;

  try {
    const result = await purgeOrgData(opts.owner, orgId);
    const tables = purgeRowCounts(result);
    if (result.failed.length > 0) {
      // Not an ack: the leg stays pending and is redelivered with backoff. The
      // tables that DID go are already gone; the retry is a no-op for them.
      logger.warn('Org data purge incomplete', { owner: opts.owner, orgId, failed: result.failed });
      safeAudit({ ...audit, outcome: 'failure', details: { owner: opts.owner, failed: result.failed, tables } });
      sendError(res, 500, `Org data purge incomplete: ${result.failed.join(', ')}`, ErrorCode.INTERNAL_ERROR);
      return;
    }
    logger.info('Org data purged', { owner: opts.owner, orgId, tables });
    safeAudit({ ...audit, details: { owner: opts.owner, tables } });
    sendSuccess(res, 200, { orgId, tables });
  } catch (err) {
    logger.warn('Org data purge failed', { owner: opts.owner, orgId, error: errorMessage(err) });
    safeAudit({ ...audit, outcome: 'failure', details: { owner: opts.owner, error: errorMessage(err) } });
    sendError(res, 500, 'Org data purge failed', ErrorCode.INTERNAL_ERROR);
  }
}
