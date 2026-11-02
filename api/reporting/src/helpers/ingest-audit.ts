// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The audit trail for reporting's MACHINE ingest (`reporting:ingest` scope).
 *
 * The ingest routes were waived from auditing as "telemetry", which left the one
 * path that writes another party's numbers into an org's DORA reports — and the
 * one a stolen ingest key would be used on — with nothing but a Prometheus
 * counter behind it. A counter says "something was dropped"; it cannot say WHICH
 * credential, WHICH pipelines, or which AWS events. So every POST now records
 * one `reporting.ingest.batch` row (counts + capped id lists), and a tenancy
 * refusal records a `reporting.ingest.rejected` failure naming what was refused.
 *
 * Volume is bounded by construction: one row per POST (the forwarder batches up
 * to MAX_EVENTS_PER_BATCH events, the health heartbeat is throttled), and every
 * id list is capped so a full batch cannot inflate a single row.
 */

import { recordAudit, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { Request } from 'express';

/** Cap on every id list an ingest audit row carries; `truncated` says when it bit. */
export const INGEST_AUDIT_ID_CAP = 50;

/** Which machine-ingest route wrote the batch. */
export type IngestSource = 'events' | 'incidents' | 'alertmanager' | 'ingest-health';

/** Why an ingest write (or part of one) was refused — the `reason` label of `reporting_ingest_rejected_total`. */
export type IngestRejectReason =
  | 'missing_scope'
  | 'cross_org_health'
  | 'foreign_org'
  | 'unregistered_pipeline'
  | 'invalid_time';

/**
 * The access-key id behind the ingest token: an exchanged key token is named by
 * its own `jti`, a token minted while holding one carries `parentKeyId`. A key
 * ID, never the secret. Undefined for a session or service-principal token.
 */
export function ingestKeyId(req: Request): string | undefined {
  const user = req.user;
  if (!user) return undefined;
  if (user.token_use === 'api_key' && typeof user.jti === 'string' && user.jti) return user.jti;
  return typeof user.parentKeyId === 'string' && user.parentKeyId ? user.parentKeyId : undefined;
}

/** Count a refused ingest write (or the refused part of one) by reason. */
export function countIngestRejection(reason: IngestRejectReason, by = 1): void {
  if (by > 0) incCounter('reporting_ingest_rejected_total', { reason }, by);
}

/** Dedupe + cap an id list, reporting whether anything was cut. */
function capIds(ids: readonly (string | undefined | null)[]): { ids: string[]; truncated: boolean } {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  return { ids: unique.slice(0, INGEST_AUDIT_ID_CAP), truncated: unique.length > INGEST_AUDIT_ID_CAP };
}

export interface IngestBatchAudit {
  source: IngestSource;
  /** The org the written rows landed in, when exactly one — the org the row is recorded for. */
  affectedOrgId?: string;
  /** Every org with a row in the batch, when more than one (events only). */
  affectedOrgIds?: readonly string[];
  outcome: 'success' | 'failure';
  counts: Record<string, number>;
  pipelineIds?: readonly (string | undefined | null)[];
  executionIds?: readonly (string | undefined | null)[];
  sourceEventIds?: readonly (string | undefined | null)[];
  incidentIds?: readonly (string | undefined | null)[];
}

/**
 * Record one `reporting.ingest.batch` row for an ingest POST. Actor = the
 * machine principal on the token (a service account's `sub`), never a person.
 */
export function recordIngestBatch(req: Request, batch: IngestBatchAudit): void {
  const lists: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, value] of [
    ['pipelineIds', batch.pipelineIds],
    ['executionIds', batch.executionIds],
    ['sourceEventIds', batch.sourceEventIds],
    ['incidentIds', batch.incidentIds],
  ] as const) {
    if (!value) continue;
    const capped = capIds(value);
    lists[key] = capped.ids;
    truncated ||= capped.truncated;
  }
  const keyId = ingestKeyId(req);
  recordAudit({
    action: 'reporting.ingest.batch',
    actorId: req.user?.sub || SYSTEM_ACTOR_ID,
    // Recorded FOR the org the rows landed in, so that org's admins see it in
    // their own trail. Not as `affectedOrgId`: a parent-org key writing a team's
    // events, or the cross-tenant plugin service, is not a cross-org ACTOR the
    // ingest would accept that field from — the caller's org rides `details`.
    orgId: batch.affectedOrgId ?? req.user?.organizationId ?? SYSTEM_ORG_ID,
    targetType: 'ingest',
    targetId: batch.source,
    outcome: batch.outcome,
    details: {
      source: batch.source,
      ...(req.user?.organizationId && req.user.organizationId !== batch.affectedOrgId ? { callerOrgId: req.user.organizationId } : {}),
      ...batch.counts,
      ...lists,
      ...(batch.affectedOrgIds && batch.affectedOrgIds.length > 1 ? { affectedOrgIds: capIds(batch.affectedOrgIds).ids } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(keyId ? { keyId } : {}),
    },
  });
}

/**
 * Record a tenancy refusal inside an otherwise-accepted ingest POST: events
 * naming pipelines that resolve to an org the credential may not write for. A
 * FAILURE row naming the offending pipeline ids and the key — never the org the
 * pipelines belong to, which would tell a prober who owns them.
 */
export function recordIngestRejection(req: Request, rejection: {
  source: IngestSource;
  reason: Extract<IngestRejectReason, 'foreign_org'>;
  dropped: number;
  pipelineIds: readonly string[];
}): void {
  const capped = capIds(rejection.pipelineIds);
  const keyId = ingestKeyId(req);
  recordAudit({
    action: 'reporting.ingest.rejected',
    actorId: req.user?.sub || SYSTEM_ACTOR_ID,
    // The CALLER's org: the refused pipelines belong to someone else, and naming
    // that org (even as the record's owner) would tell a prober who it is.
    orgId: req.user?.organizationId ?? SYSTEM_ORG_ID,
    targetType: 'ingest',
    targetId: rejection.source,
    outcome: 'failure',
    details: {
      source: rejection.source,
      reason: rejection.reason,
      dropped: rejection.dropped,
      pipelineIds: capped.ids,
      ...(capped.truncated ? { truncated: true } : {}),
      ...(keyId ? { keyId } : {}),
    },
  });
}
