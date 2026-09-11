// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit Activity panels over platform's MongoDB audit trail.
 *
 * The `audit-store` catalog entries resolve here instead of Prometheus. Matrix
 * results use the same series shape as a Prometheus range query, so the chart
 * and top-N panels render either source unchanged.
 *
 * Tenancy: every query goes through `buildAuditQuery`, the same predicate
 * `GET /audit` uses. An org admin is confined to rows where their org is the
 * actor's org OR the affected org; a sysadmin (`orgId: undefined`) sees every
 * org. A non-sysadmin with no org gets an empty result rather than an
 * unscoped query.
 */

import type { AuditStoreQuery, RangeKey } from './catalog.js';
import { rangeSeconds } from './catalog.js';
import AuditEvent from '../models/audit-event.js';
import { buildAuditQuery } from '../services/audit-service.js';

/** Time-bucket width per range for the events-over-time panel — 12–24 bars. */
const BUCKET_SECONDS: Record<RangeKey, number> = { '1h': 300, '6h': 1800, '24h': 3600 };
const TOP_ACTORS_WINDOW_SECONDS = 86_400;
const TOP_ACTORS_LIMIT = 10;

export interface AuditStoreScope {
  /** Sysadmins see every org. */
  isSuperAdmin: boolean;
  /** The caller's org — required for a non-sysadmin. */
  orgId?: string;
}

export interface AuditStoreParams {
  range: RangeKey;
  /** Query end (unix seconds). */
  end: number;
  /** Max rows for `recent_events`. */
  limit: number;
  vars: { event?: string; actor?: string; requestId?: string };
}

/** One aggregated series — the Prometheus range-query shape (unix seconds). */
export interface AuditSeries {
  labels: Record<string, string>;
  values: Array<{ time: number; value: string }>;
}

/** One audit event as a recent-events table row. */
export interface AuditEntry {
  /** Unix milliseconds. */
  time: number;
  /** Human summary: target and a failure marker. */
  line: string;
  /** `event`, `actor`, `outcome`, and (when known) `org_id`. */
  labels: Record<string, string>;
}

export type AuditStoreResult =
  | { kind: 'matrix'; series: AuditSeries[]; step: string }
  | { kind: 'stream'; entries: AuditEntry[] };

/** The org-scoping + time-window predicate. Null = the caller can see nothing. */
function scopedQuery(scope: AuditStoreScope, from: Date, to: Date): Record<string, unknown> | null {
  if (!scope.isSuperAdmin && !scope.orgId) return null;
  return buildAuditQuery({
    orgIdOrAffected: scope.isSuperAdmin ? undefined : scope.orgId,
    createdFrom: from,
    createdTo: to,
  });
}

const actorLabel = (actorId?: string, actorEmail?: string) => actorEmail || actorId || 'unknown';

export async function queryAuditStore(
  name: AuditStoreQuery,
  scope: AuditStoreScope,
  params: AuditStoreParams,
): Promise<AuditStoreResult> {
  const endMs = params.end * 1000;
  switch (name) {
    case 'events_by_action': {
      const bucket = BUCKET_SECONDS[params.range];
      const step = `${bucket}s`;
      const match = scopedQuery(scope, new Date(endMs - rangeSeconds(params.range) * 1000), new Date(endMs));
      if (!match) return { kind: 'matrix', series: [], step };
      const rows = await AuditEvent.aggregate<{ _id: { action: string; bucket: Date }; count: number }>([
        { $match: match },
        {
          $group: {
            _id: { action: '$action', bucket: { $dateTrunc: { date: '$createdAt', unit: 'second', binSize: bucket } } },
            count: { $sum: 1 },
          },
        },
      ]);
      // Zero-fill every bucket in the window so the chart's time axis is
      // truthful (empty intervals render as gaps, not as missing bars).
      const first = Math.floor((params.end - rangeSeconds(params.range)) / bucket) * bucket;
      const times: number[] = [];
      for (let t = first; t <= params.end; t += bucket) times.push(t);
      const byAction = new Map<string, Map<number, number>>();
      for (const { _id, count } of rows) {
        const counts = byAction.get(_id.action) ?? new Map<number, number>();
        counts.set(Math.floor(_id.bucket.getTime() / 1000), count);
        byAction.set(_id.action, counts);
      }
      const series = [...byAction.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([action, counts]) => ({
          labels: { event: action },
          values: times.map(time => ({ time, value: String(counts.get(time) ?? 0) })),
        }));
      return { kind: 'matrix', series, step };
    }

    case 'top_actors_24h': {
      const match = scopedQuery(scope, new Date(endMs - TOP_ACTORS_WINDOW_SECONDS * 1000), new Date(endMs));
      if (!match) return { kind: 'matrix', series: [], step: `${TOP_ACTORS_WINDOW_SECONDS}s` };
      const rows = await AuditEvent.aggregate<{ _id: string; email?: string; count: number }>([
        { $match: match },
        { $group: { _id: '$actorId', email: { $max: '$actorEmail' }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: TOP_ACTORS_LIMIT },
      ]);
      const series = rows.map(r => ({
        labels: { actor: actorLabel(r._id, r.email) },
        values: [{ time: params.end, value: String(r.count) }],
      }));
      return { kind: 'matrix', series, step: `${TOP_ACTORS_WINDOW_SECONDS}s` };
    }

    case 'recent_events': {
      const match = scopedQuery(scope, new Date(endMs - rangeSeconds(params.range) * 1000), new Date(endMs));
      if (!match) return { kind: 'stream', entries: [] };
      const { event, actor, requestId } = params.vars;
      if (event) match.action = event;
      if (requestId) match.requestId = requestId;
      // `$and` because the org-scope predicate already owns the top-level `$or`.
      if (actor) match.$and = [{ $or: [{ actorId: actor }, { actorEmail: actor }] }];
      const docs = await AuditEvent.find(match).sort({ createdAt: -1 }).limit(params.limit).lean();
      const entries = docs.map((d) => {
        const target = d.targetType ? `${d.targetType}${d.targetId ? `:${d.targetId}` : ''}` : '';
        const labels: Record<string, string> = {
          event: d.action,
          actor: actorLabel(d.actorId, d.actorEmail),
          outcome: d.outcome ?? 'success',
        };
        const org = d.affectedOrgId ?? d.orgId;
        if (org) labels.org_id = org;
        return {
          time: new Date(d.createdAt).getTime(),
          line: [target, d.outcome === 'failure' ? 'FAILED' : ''].filter(Boolean).join(' ') || d.action,
          labels,
        };
      });
      return { kind: 'stream', entries };
    }
  }
}
