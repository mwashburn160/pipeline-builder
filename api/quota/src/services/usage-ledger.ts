// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The quota USAGE LEDGER: one event per increment, denial and refund, and the
 * grouped reads behind "what used this quota" (`GET /quotas/:orgId/usage`).
 *
 * Writes are fire-and-forget. The ledger is attribution, not enforcement: the
 * counter on the organizations doc is the number the cap binds on, and a ledger
 * write that fails must never fail (or slow) the increment it describes. A lost
 * write is counted (`quota_usage_event_write_failed_total`) and logged.
 */

import { createLogger, emitCounter, errorMessage } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaUsageAttribution } from '@pipeline-builder/api-core';
import { UsageEvent, type UsageOutcome } from '../models/usage-event.js';
import type { USAGE_GROUP_BY } from '../validation/schemas.js';

const logger = createLogger('usage-ledger');

/** Counter for every metered outcome, by quota type. */
export const QUOTA_INCREMENTS_METRIC = 'quota_increments_total';

/** One ledger write. */
export interface UsageEventInput {
  orgId: string;
  rootOrgId: string;
  quotaType: QuotaType;
  amount: number;
  outcome: UsageOutcome;
  attribution?: QuotaUsageAttribution;
}

/**
 * Record one usage event and count it (`quota_increments_total{type,outcome}`).
 * Never throws and never awaits on the caller's path.
 */
export function recordUsageEvent(input: UsageEventInput): void {
  emitCounter(QUOTA_INCREMENTS_METRIC, { type: input.quotaType, outcome: input.outcome });
  const a = input.attribution ?? {};
  UsageEvent.create({
    orgId: input.orgId,
    rootOrgId: input.rootOrgId,
    quotaType: input.quotaType,
    amount: input.amount,
    outcome: input.outcome,
    principalType: a.principalType,
    principalId: a.principalId,
    keyId: a.keyId,
    route: a.route,
    pipelineId: a.pipelineId,
    requestId: a.requestId,
    at: new Date(),
  }).catch((err: unknown) => {
    emitCounter('quota_usage_event_write_failed_total', { type: input.quotaType });
    logger.warn('Usage event not recorded', { orgId: input.orgId, quotaType: input.quotaType, error: errorMessage(err) });
  });
}

/** What a usage read groups by. */
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

/** Most groups one read returns (largest first) — the long tail is noise on a dashboard. */
export const USAGE_MAX_GROUPS = 500;

export interface UsageQuery {
  /** The org the caller asked about. A pool ROOT sees its whole account; a team sees itself. */
  orgId: string;
  quotaType?: QuotaType;
  from: Date;
  to: Date;
  groupBy: UsageGroupBy;
}

/** One group of a usage read. `net` = counted − refunded (what the counter actually moved). */
export interface UsageGroup {
  /** The group value: a principal id, route pattern, pipeline id or `YYYY-MM-DD` day; null = unattributed. */
  key: string | null;
  /** Principal groups only. */
  principalType?: string;
  /** Principal groups only: how many distinct credentials (keys / tokens) spent it. */
  keyCount?: number;
  counted: number;
  denied: number;
  refunded: number;
  net: number;
}

const GROUP_KEY: Record<UsageGroupBy, unknown> = {
  principal: { id: '$principalId', type: '$principalType' },
  route: '$route',
  pipeline: '$pipelineId',
  day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: 'UTC' } },
};

const sumWhen = (outcome: UsageOutcome) => ({ $sum: { $cond: [{ $eq: ['$outcome', outcome] }, '$amount', 0] } });

/**
 * Grouped usage for one org over `[from, to)`.
 *
 * Scope follows pooling without a hierarchy lookup: `{ rootOrgId: X } ∪
 * { orgId: X }`. For a pool root (and a flat org, which is its own root) that is
 * every event in the account — the same units its pooled counter holds; for a
 * team, `rootOrgId` never equals its own id, so it is exactly the team's own
 * events. Both branches ride an index.
 */
export async function queryUsage(q: UsageQuery): Promise<UsageGroup[]> {
  const match: Record<string, unknown> = {
    $or: [{ rootOrgId: q.orgId }, { orgId: q.orgId }],
    at: { $gte: q.from, $lt: q.to },
  };
  if (q.quotaType) match.quotaType = q.quotaType;

  const rows = await UsageEvent.aggregate<{
    _id: unknown;
    counted: number;
    denied: number;
    refunded: number;
    keys?: unknown[];
  }>([
    { $match: match },
    {
      $group: {
        _id: GROUP_KEY[q.groupBy],
        counted: sumWhen('counted'),
        denied: sumWhen('denied'),
        refunded: sumWhen('refunded'),
        ...(q.groupBy === 'principal' ? { keys: { $addToSet: '$keyId' } } : {}),
      },
    },
    { $sort: q.groupBy === 'day' ? { _id: 1 } : { counted: -1, denied: -1 } },
    { $limit: USAGE_MAX_GROUPS },
  ]);

  return rows.map((r) => {
    const base = { counted: r.counted, denied: r.denied, refunded: r.refunded, net: Math.max(0, r.counted - r.refunded) };
    if (q.groupBy === 'principal') {
      const id = r._id as { id?: string | null; type?: string | null } | null;
      return {
        key: id?.id ?? null,
        ...(id?.type ? { principalType: id.type } : {}),
        keyCount: (r.keys ?? []).filter((k) => k !== null && k !== undefined).length,
        ...base,
      };
    }
    return { key: typeof r._id === 'string' ? r._id : null, ...base };
  });
}

/**
 * RFC 4180 cell, plus a formula guard: a value a spreadsheet would evaluate
 * (`=`, `+`, `-`, `@`, tab, CR) is prefixed with `'`. Route patterns and ids
 * never start that way legitimately, so the guard costs nothing.
 */
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The CSV export of one usage read (header row + one row per group). */
export function usageToCsv(groupBy: UsageGroupBy, groups: UsageGroup[]): string {
  const header = groupBy === 'principal'
    ? ['principal', 'principalType', 'keys', 'counted', 'denied', 'refunded', 'net']
    : [groupBy, 'counted', 'denied', 'refunded', 'net'];
  const rows = groups.map((g) => (groupBy === 'principal'
    ? [g.key ?? '(unattributed)', g.principalType ?? '', g.keyCount ?? 0, g.counted, g.denied, g.refunded, g.net]
    : [g.key ?? '(unattributed)', g.counted, g.denied, g.refunded, g.net]
  ).map(csvCell).join(','));
  return [header.join(','), ...rows].join('\n');
}
