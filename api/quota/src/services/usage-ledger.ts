// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The quota USAGE LEDGER: hourly buckets of every increment, denial, overshoot
 * and refund, plus a raw row for each exceptional one, and the grouped reads
 * behind "what used this quota" (`GET /quotas/:orgId/usage`).
 *
 * Writes are fire-and-forget. The ledger is attribution, not enforcement: the
 * counter on the organizations doc is the number the cap binds on, and a ledger
 * write that fails must never fail (or slow) the increment it describes. A lost
 * write is counted (`quota_usage_event_write_failed_total`) and logged.
 */

import { createLogger, emitCounter, errorMessage } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaUsageAttribution } from '@pipeline-builder/api-core';
import { UsageBucket } from '../models/usage-bucket.js';
import { UsageEvent, type UsageOutcome } from '../models/usage-event.js';
import type { USAGE_GROUP_BY } from '../validation/schemas.js';

const logger = createLogger('usage-ledger');

/** Counter of metered UNITS by quota type and outcome (value = amount, not calls). */
export const QUOTA_INCREMENTS_METRIC = 'quota_increments_total';

/** One ledger write. */
export interface UsageEventInput {
  orgId: string;
  rootOrgId: string;
  quotaType: QuotaType;
  amount: number;
  outcome: UsageOutcome;
  attribution?: QuotaUsageAttribution;
  /** AI calls: provider tokens to add to the bucket (an after-the-call usage report). */
  tokensIn?: number;
  tokensOut?: number;
  /**
   * An after-the-call usage REPORT: written even at zero units and zero tokens,
   * so a call that spent no unit (BYOK, impersonation, weight 0) still appears
   * in the breakdown under its feature / model / key source.
   */
  report?: boolean;
}

const HOUR_MS = 3_600_000;

/** Start of the UTC hour containing `at`. */
export function bucketHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Record usage: `$inc` each input's hourly bucket (one `bulkWrite`), and insert
 * a raw row for every outcome but `counted`. Counts each on
 * `quota_increments_total{type,outcome}` by units. Never throws and never
 * awaits on the caller's path. A zero-amount input is ignored unless it carries
 * tokens or is a usage `report`.
 */
export function recordUsage(inputs: UsageEventInput[]): void {
  const live = inputs.filter((i) => i.amount > 0 || (i.tokensIn ?? 0) > 0 || (i.tokensOut ?? 0) > 0 || i.report === true);
  if (live.length === 0) return;
  const now = new Date();
  const hour = bucketHour(now);
  for (const i of live) {
    if (i.amount > 0) emitCounter(QUOTA_INCREMENTS_METRIC, { type: i.quotaType, outcome: i.outcome }, i.amount);
  }

  const failed = (err: unknown) => {
    for (const i of live) emitCounter('quota_usage_event_write_failed_total', { type: i.quotaType });
    logger.warn('Usage not recorded', { orgId: live[0]!.orgId, quotaType: live[0]!.quotaType, error: errorMessage(err) });
  };

  UsageBucket.bulkWrite(live.map((i) => {
    const a = i.attribution ?? {};
    return {
      updateOne: {
        filter: {
          orgId: i.orgId,
          hour,
          quotaType: i.quotaType,
          outcome: i.outcome,
          principalType: a.principalType ?? null,
          principalId: a.principalId ?? null,
          keyId: a.keyId ?? null,
          route: a.route ?? null,
          pipelineId: a.pipelineId ?? null,
          feature: a.feature ?? null,
          model: a.model ?? null,
          keySource: a.keySource ?? null,
        },
        update: {
          $inc: { amount: i.amount, tokensIn: i.tokensIn ?? 0, tokensOut: i.tokensOut ?? 0 },
          $set: { rootOrgId: i.rootOrgId },
        },
        upsert: true,
      },
    };
  }), { ordered: false }).catch(failed);

  const exceptional = live.filter((i) => i.outcome !== 'counted' && i.amount > 0);
  if (exceptional.length > 0) {
    UsageEvent.insertMany(exceptional.map((i) => {
      const a = i.attribution ?? {};
      return {
        orgId: i.orgId,
        rootOrgId: i.rootOrgId,
        quotaType: i.quotaType,
        amount: i.amount,
        outcome: i.outcome,
        principalType: a.principalType,
        principalId: a.principalId,
        keyId: a.keyId,
        route: a.route,
        pipelineId: a.pipelineId,
        requestId: a.requestId,
        at: now,
      };
    }), { ordered: false }).catch(failed);
  }
}

/** Record one usage event (see {@link recordUsage}). */
export function recordUsageEvent(input: UsageEventInput): void {
  recordUsage([input]);
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
  /** The group value: a principal id, route pattern, pipeline id, `YYYY-MM-DD` day, feature or model id; null = unattributed. */
  key: string | null;
  /** Principal groups only. */
  principalType?: string;
  /** Principal groups only: how many distinct credentials (keys / tokens) spent it. */
  keyCount?: number;
  /** Feature groups only: the AI product surface (= `key`). */
  feature?: string;
  /** Model groups only: the model id (= `key`). */
  model?: string;
  /** Model groups only: whose key served it (`platform` | `org` | `request`) — a model is grouped once per key source. */
  keySource?: string;
  counted: number;
  denied: number;
  /** Served metered calls that did not fit under the cap (never counted). */
  overshoot: number;
  refunded: number;
  net: number;
  /** AI provider tokens reported for the group (0 for non-AI quotas). */
  tokensIn: number;
  tokensOut: number;
}

/** One aggregated bucket group, as `$group` returns it. */
interface GroupRow {
  _id: unknown;
  counted: number;
  denied: number;
  overshoot: number;
  refunded: number;
  tokensIn?: number;
  tokensOut?: number;
  keys?: unknown[];
}

/** The `UsageGroup` fields a grouping owns: its key and its dimension-specific labels. */
type GroupLabels = Pick<UsageGroup, 'key' | 'principalType' | 'keyCount' | 'feature' | 'model' | 'keySource'>;

/** What one `groupBy` value means, everywhere it is read. */
interface UsageGrouping {
  /** The `$group` `_id` expression over the bucket fields. */
  groupKey: unknown;
  /** Turn the aggregated `_id` (and `keys`) into the group's labels. */
  labels: (row: GroupRow) => GroupLabels;
  /** The CSV's leading columns (before the shared numeric ones), and their cells. */
  csvColumns: readonly string[];
  csvCells: (group: UsageGroup, key: string) => unknown[];
}

const stringKey = (row: GroupRow): string | null => (typeof row._id === 'string' ? row._id : null);

/**
 * Every `groupBy` value, keyed — the `$group` key, the response labels and the
 * CSV columns for each live in its one entry. They were a lookup table plus two
 * `principal ? … : model ? … : …` ladders (the mapper and the CSV writer), and
 * a new grouping had to be added to all three by hand; `Record<UsageGroupBy, …>`
 * now makes the compiler demand the whole entry.
 */
const USAGE_GROUPINGS: Record<UsageGroupBy, UsageGrouping> = {
  principal: {
    groupKey: { id: '$principalId', type: '$principalType' },
    labels: (r) => {
      const id = r._id as { id?: string | null; type?: string | null } | null;
      return {
        key: id?.id ?? null,
        ...(id?.type ? { principalType: id.type } : {}),
        keyCount: (r.keys ?? []).filter((k) => k !== null && k !== undefined).length,
      };
    },
    csvColumns: ['principal', 'principalType', 'keys'],
    csvCells: (g, key) => [key, g.principalType ?? '', g.keyCount ?? 0],
  },
  route: { groupKey: '$route', labels: (r) => ({ key: stringKey(r) }), csvColumns: ['route'], csvCells: (_g, key) => [key] },
  pipeline: { groupKey: '$pipelineId', labels: (r) => ({ key: stringKey(r) }), csvColumns: ['pipeline'], csvCells: (_g, key) => [key] },
  day: {
    groupKey: { $dateToString: { format: '%Y-%m-%d', date: '$hour', timezone: 'UTC' } },
    labels: (r) => ({ key: stringKey(r) }),
    csvColumns: ['day'],
    csvCells: (_g, key) => [key],
  },
  feature: {
    groupKey: '$feature',
    labels: (r) => {
      const key = stringKey(r);
      return { key, ...(key ? { feature: key } : {}) };
    },
    csvColumns: ['feature'],
    csvCells: (_g, key) => [key],
  },
  model: {
    groupKey: { id: '$model', keySource: '$keySource' },
    labels: (r) => {
      const id = r._id as { id?: string | null; keySource?: string | null } | null;
      return {
        key: id?.id ?? null,
        ...(id?.id ? { model: id.id } : {}),
        ...(id?.keySource ? { keySource: id.keySource } : {}),
      };
    },
    csvColumns: ['model', 'keySource'],
    csvCells: (g, key) => [key, g.keySource ?? ''],
  },
};

const sumWhen = (outcome: UsageOutcome) => ({ $sum: { $cond: [{ $eq: ['$outcome', outcome] }, '$amount', 0] } });

/**
 * Grouped usage for one org over `[from, to)`, read from the hourly buckets —
 * so `from` is effectively rounded DOWN to its hour (a bucket is in or out
 * whole).
 *
 * Scope follows pooling without a hierarchy lookup: `{ rootOrgId: X } ∪
 * { orgId: X }`. For a pool root (and a flat org, which is its own root) that is
 * every bucket in the account — the same units its pooled counter holds; for a
 * team, `rootOrgId` never equals its own id, so it is exactly the team's own
 * buckets. Each branch rides an index led by (scope id, hour), with or without
 * a quota type.
 */
export async function queryUsage(q: UsageQuery): Promise<UsageGroup[]> {
  const match: Record<string, unknown> = {
    $or: [{ rootOrgId: q.orgId }, { orgId: q.orgId }],
    hour: { $gte: bucketHour(q.from), $lt: q.to },
  };
  if (q.quotaType) match.quotaType = q.quotaType;

  const grouping = USAGE_GROUPINGS[q.groupBy];
  const rows = await UsageBucket.aggregate<GroupRow>([
    { $match: match },
    {
      $group: {
        _id: grouping.groupKey,
        counted: sumWhen('counted'),
        denied: sumWhen('denied'),
        overshoot: sumWhen('overshoot'),
        refunded: sumWhen('refunded'),
        tokensIn: { $sum: { $ifNull: ['$tokensIn', 0] } },
        tokensOut: { $sum: { $ifNull: ['$tokensOut', 0] } },
        ...(q.groupBy === 'principal' ? { keys: { $addToSet: '$keyId' } } : {}),
      },
    },
    // AI groups rank by tokens too: a BYOK model spends no unit, only tokens.
    { $sort: q.groupBy === 'day' ? { _id: 1 } : { counted: -1, denied: -1, tokensOut: -1 } },
    { $limit: USAGE_MAX_GROUPS },
  ]);

  return rows.map((r) => ({
    ...grouping.labels(r),
    counted: r.counted,
    denied: r.denied,
    overshoot: r.overshoot ?? 0,
    refunded: r.refunded,
    net: Math.max(0, r.counted - r.refunded),
    tokensIn: r.tokensIn ?? 0,
    tokensOut: r.tokensOut ?? 0,
  }));
}

/**
 * Platform-key AI tokens one account reported since `since` — the per-period
 * token budget's reading. BYOK calls (`keySource` `org` / `request`) are left
 * out: the budget bounds the platform's provider spend, which a customer key
 * does not touch. Rides the `{ rootOrgId, hour }` / bucket-key indexes.
 */
export async function aiTokensSince(rootOrgId: string, since: Date): Promise<number> {
  const rows = await UsageBucket.aggregate<{ tokens: number }>([
    {
      $match: {
        $or: [{ rootOrgId }, { orgId: rootOrgId }],
        hour: { $gte: bucketHour(since) },
        quotaType: 'aiCalls',
        keySource: { $nin: ['org', 'request'] },
      },
    },
    { $group: { _id: null, tokens: { $sum: { $add: [{ $ifNull: ['$tokensIn', 0] }, { $ifNull: ['$tokensOut', 0] }] } } } },
  ]);
  return rows[0]?.tokens ?? 0;
}

/**
 * The `aiCalls` units one principal spent across an account since `since`:
 * counted − refunded — the per-member share's reading. Hour-granular (the
 * bucket's `from` rounds down), which only ever counts a little MORE.
 */
export async function aiCallsByPrincipalSince(rootOrgId: string, principalId: string, since: Date): Promise<number> {
  const rows = await UsageBucket.aggregate<{ counted: number; refunded: number }>([
    {
      $match: {
        $or: [{ rootOrgId }, { orgId: rootOrgId }],
        hour: { $gte: bucketHour(since) },
        quotaType: 'aiCalls',
        principalId,
      },
    },
    { $group: { _id: null, counted: sumWhen('counted'), refunded: sumWhen('refunded') } },
  ]);
  const r = rows[0];
  return r ? Math.max(0, r.counted - r.refunded) : 0;
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
  const { csvColumns, csvCells } = USAGE_GROUPINGS[groupBy];
  const header = [...csvColumns, 'counted', 'denied', 'overshoot', 'refunded', 'net', 'tokensIn', 'tokensOut'];
  const rows = groups.map((g) => {
    const leadCells = csvCells(g, g.key ?? '(unattributed)');
    return [...leadCells, g.counted, g.denied, g.overshoot, g.refunded, g.net, g.tokensIn, g.tokensOut].map(csvCell).join(',');
  });
  return [header.join(','), ...rows].join('\n');
}
