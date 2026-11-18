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
 * A service whose data is NOT in `ORG_DATA_OWNERSHIP` (billing, quota: Mongo)
 * passes its own `purge` callback instead of an `owner`, and gets the same
 * envelope: contract param parse, never-throw audit, 500 on a failed table or a
 * throw, and the success reply (plus `remaining` when the callback reports it).
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

/** What a purge reports back: per-table counts, and what it could not finish. */
export interface OrgPurgeOutcome {
  /** Rows removed, per table / collection. */
  tables: Record<string, number>;
  /** Tables that failed outright — any entry answers 500 (not an ack). */
  failed?: string[];
  /**
   * Rows deliberately KEPT for a retry (billing: subscriptions still live at the
   * provider). Echoed in the reply whenever present; any non-zero count is a 200
   * the caller's `incomplete` hook reads as NOT an ack, and audits as a failure.
   */
  remaining?: Record<string, number>;
}

/** A service's own teardown, for data that is not in `ORG_DATA_OWNERSHIP` (Mongo). */
export type OrgPurgeFn = (orgId: string) => Promise<OrgPurgeOutcome>;

interface OrgDataPurgeBase {
  /** The contract the route is mounted at (its `:orgId` param is read). */
  contract: InternalEndpointContract;
  /** The audit action the service declares on the route (`audited(...)`). */
  auditAction: RemoteAuditAction;
}

/** The Postgres path: tear down `owner`'s slice of `ORG_DATA_OWNERSHIP`. */
export interface OwnedOrgDataPurgeOptions extends OrgDataPurgeBase {
  /** Whose slice of `ORG_DATA_OWNERSHIP` this service tears down. */
  owner: OrgDataOwner;
  purge?: never;
  service?: never;
}

/** The callback path: the service tears its own (non-Postgres) data down. */
export interface CallbackOrgDataPurgeOptions extends OrgDataPurgeBase {
  owner?: never;
  /** Runs the purge; throwing answers 500. */
  purge: OrgPurgeFn;
  /** Names the service in the audit row (`details.owner`), logs and the 500 message. */
  service: string;
}

/** What one service's purge leg needs to know about itself: `owner` OR `purge`. */
export type OrgDataPurgeOptions = OwnedOrgDataPurgeOptions | CallbackOrgDataPurgeOptions;

/** `purgeOrgData` for `owner`, as an {@link OrgPurgeFn}. */
function ownedPurge(owner: OrgDataOwner): OrgPurgeFn {
  return async (orgId) => {
    const result = await purgeOrgData(owner, orgId);
    return { tables: purgeRowCounts(result), failed: result.failed };
  };
}

/**
 * Parse `:orgId`, purge it (`owner`'s rows, or the service's own `purge`),
 * audit the counts (or the failure) and answer the outbox. Never throws.
 */
export async function handleOrgDataPurge(req: Request, res: Response, opts: OrgDataPurgeOptions): Promise<void> {
  const params = parseContractParams(opts.contract, req);
  if (!params.ok) {
    sendBadRequest(res, contractErrorMessage(params), ErrorCode.MISSING_REQUIRED_FIELD);
    return;
  }
  const orgId = String((params.value as { orgId: string }).orgId);
  const owner: string = opts.purge ? opts.service : opts.owner;
  const purge = opts.purge ?? ownedPurge(opts.owner);
  const audit = {
    action: opts.auditAction,
    actorId: SYSTEM_ACTOR_ID,
    orgId: SYSTEM_ORG_ID,
    affectedOrgId: orgId,
    targetType: 'organization',
    targetId: orgId,
  } as const;

  try {
    const { tables, failed = [], remaining } = await purge(orgId);
    if (failed.length > 0) {
      // Not an ack: the leg stays pending and is redelivered with backoff. The
      // tables that DID go are already gone; the retry is a no-op for them.
      logger.warn('Org data purge incomplete', { owner, orgId, failed });
      safeAudit({ ...audit, outcome: 'failure', details: { owner, failed, tables } });
      sendError(res, 500, `Org data purge incomplete: ${failed.join(', ')}`, ErrorCode.INTERNAL_ERROR);
      return;
    }
    if (remaining && Object.values(remaining).some((n) => n > 0)) {
      // A 200, but not an ack (the caller's `incomplete` hook reads `remaining`):
      // the kept rows are retried on the next delivery.
      logger.warn('Org data purge left rows for a retry', { owner, orgId, tables, remaining });
      safeAudit({ ...audit, outcome: 'failure', details: { owner, tables, remaining } });
    } else {
      logger.info('Org data purged', { owner, orgId, tables });
      safeAudit({ ...audit, details: { owner, tables } });
    }
    sendSuccess(res, 200, remaining ? { orgId, tables, remaining } : { orgId, tables });
  } catch (err) {
    logger.warn('Org data purge failed', { owner, orgId, error: errorMessage(err) });
    safeAudit({ ...audit, outcome: 'failure', details: { owner, error: errorMessage(err) } });
    sendError(res, 500, opts.purge ? `Org ${owner} purge failed` : 'Org data purge failed', ErrorCode.INTERNAL_ERROR);
  }
}
