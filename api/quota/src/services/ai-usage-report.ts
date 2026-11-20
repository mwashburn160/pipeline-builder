// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI ASSISTANT USAGE REPORT (`GET /quotas/:orgId/ai-usage`): how much the
 * org's AI features were used, and how often the drafts they produced were
 * kept.
 *
 *  - USAGE is read from the usage ledger's `aiCalls` hourly buckets
 *    (services/usage-ledger.ts): calls (one per usage report = one call that
 *    reached the provider), net units charged (counted − refunded, the same
 *    `net` "What used this" shows), and tokens. Sliced per time bucket, per
 *    caller TYPE, per feature, and — for a rollup — per team.
 *  - ACCEPTANCE is read from the draft-outcome buckets
 *    (models/ai-draft-outcome.ts): accepted / edited-then-accepted / discarded,
 *    per time bucket and per feature.
 *
 * NEVER PER PERSON. The pipelines below never group by, project or return a
 * principal id or key id — a caller is a TYPE (user session / service account /
 * system), a team is an org. The draft-outcome store holds no person at all.
 *
 * Buckets honour the viewer's `tz` / `weekStart` (`$dateTrunc` in the zone).
 * The ledger is hourly in UTC, so a zone whose offset is not a whole hour
 * (e.g. Asia/Kolkata) places each boundary hour wholly on one side.
 */

import type { WeekStart } from '@pipeline-builder/api-core';
import type { PipelineStage } from 'mongoose';
import { config } from '../config.js';
import {
  AI_CALLER_TYPE_LABELS,
  AI_CALLER_TYPES,
  AI_REPORT_FEATURES,
  reportFeatureOf,
  type AiCallerType,
  type AiDraftFeature,
  type AiDraftOutcome,
  type AiReportFeature,
} from './ai-draft-catalog.js';
import { bucketHour, csvCell } from './usage-ledger.js';
import { toOrgId } from '../helpers/org-id.js';
import { AiDraftOutcomeBucket } from '../models/ai-draft-outcome.js';
import { Organization } from '../models/organization.js';
import { UsageBucket } from '../models/usage-bucket.js';

export * from './ai-draft-catalog.js';

/** Time-bucket sizes the report offers. */
export const AI_USAGE_INTERVALS = ['day', 'week'] as const;
export type AiUsageInterval = (typeof AI_USAGE_INTERVALS)[number];

/** Most teams one rollup lists (largest first). */
const MAX_TEAMS = 500;

// ── Wire shapes (frontend copies are registered in wire-type-drift) ─────────

/** Usage figures of one slice. `units` = net `aiCalls` units charged. */
export interface AiUsageFigures {
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
}

/** One time bucket: usage plus the draft outcomes recorded in it. */
export interface AiUsageBucketRow {
  /** `YYYY-MM-DD` — the day, or the first day of the week, in the report's tz. */
  bucket: string;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
  accepted: number;
  editedAccepted: number;
  discarded: number;
  outcomes: number;
  /** (accepted + edited) / outcomes; null with no outcomes. */
  acceptanceRate: number | null;
}

/** Usage by caller type. */
export interface AiCallerTypeRow {
  callerType: AiCallerType;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
}

/** Usage by team (rollup only). `name` null when the org row is unreadable. */
export interface AiTeamRow {
  orgId: string;
  name: string | null;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
}

/** Usage and acceptance by feature. */
export interface AiFeatureRow {
  feature: AiReportFeature;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
  accepted: number;
  editedAccepted: number;
  discarded: number;
  outcomes: number;
  acceptanceRate: number | null;
}

/** The whole-range totals. */
export interface AiUsageTotals {
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
  accepted: number;
  editedAccepted: number;
  discarded: number;
  outcomes: number;
  acceptanceRate: number | null;
}

/** `GET /quotas/:orgId/ai-usage` → `data.report`. */
export interface AiUsageReport {
  orgId: string;
  /** `org`: this org's own usage; `rollup`: the account (the org and its teams). */
  scope: 'org' | 'rollup';
  from: string;
  to: string;
  interval: AiUsageInterval;
  tz: string;
  weekStart: WeekStart;
  retentionDays: number;
  /**
   * When the first draft outcome in scope was recorded (any time, not just this
   * range); null when none ever was — acceptance tracking starts with the
   * release that added it, so older ranges have usage but no acceptance.
   */
  acceptanceSince: string | null;
  totals: AiUsageTotals;
  buckets: AiUsageBucketRow[];
  byCallerType: AiCallerTypeRow[];
  /** Null unless `scope` is `rollup`. */
  byTeam: AiTeamRow[] | null;
  byFeature: AiFeatureRow[];
}

export interface AiUsageReportQuery {
  orgId: string;
  /** Include the org's teams (a `reports:rollup` holder who asked). */
  rollup: boolean;
  from: Date;
  to: Date;
  interval: AiUsageInterval;
  tz: string;
  weekStart: WeekStart;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Count one draft outcome into its hourly bucket. Org, feature, outcome — nothing else. */
export async function recordDraftOutcome(input: { orgId: string; rootOrgId: string; feature: AiDraftFeature; outcome: AiDraftOutcome }): Promise<void> {
  await AiDraftOutcomeBucket.updateOne(
    { orgId: input.orgId, hour: bucketHour(new Date()), feature: input.feature, outcome: input.outcome },
    { $inc: { count: 1 }, $set: { rootOrgId: input.rootOrgId } },
    { upsert: true },
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

interface SumRow { _id: unknown; calls?: number; counted?: number; refunded?: number; tokensIn?: number; tokensOut?: number }
interface CountRow { _id: unknown; n: number }

const sumWhen = (outcome: string) => ({ $sum: { $cond: [{ $eq: ['$outcome', outcome] }, '$amount', 0] } });
const USAGE_SUMS = {
  calls: { $sum: { $ifNull: ['$calls', 0] } },
  counted: sumWhen('counted'),
  refunded: sumWhen('refunded'),
  tokensIn: { $sum: { $ifNull: ['$tokensIn', 0] } },
  tokensOut: { $sum: { $ifNull: ['$tokensOut', 0] } },
};

/** The caller TYPE of a bucket, computed in the pipeline (the principal id is never read). */
const CALLER_TYPE_EXPR = {
  $switch: {
    branches: [
      { case: { $eq: ['$principalType', 'user'] }, then: 'user' },
      { case: { $eq: ['$principalType', 'service_account'] }, then: 'service_account' },
    ],
    default: 'system',
  },
};

/** `YYYY-MM-DD` of the day / week containing `$hour`, in `tz`. */
function bucketExpr(interval: AiUsageInterval, tz: string, weekStart: WeekStart) {
  return {
    $dateToString: {
      format: '%Y-%m-%d',
      timezone: tz,
      date: { $dateTrunc: { date: '$hour', unit: interval, timezone: tz, ...(interval === 'week' ? { startOfWeek: weekStart } : {}) } },
    },
  };
}

/** Pooling scope without a hierarchy walk (same rule as `queryUsage`). */
function scopeMatch(q: AiUsageReportQuery): Record<string, unknown> {
  return q.rollup ? { $or: [{ rootOrgId: q.orgId }, { orgId: q.orgId }] } : { orgId: q.orgId };
}

function figures(r: SumRow | undefined): AiUsageFigures {
  return {
    calls: r?.calls ?? 0,
    units: Math.max(0, (r?.counted ?? 0) - (r?.refunded ?? 0)),
    tokensIn: r?.tokensIn ?? 0,
    tokensOut: r?.tokensOut ?? 0,
  };
}

const addFigures = (a: AiUsageFigures, b: AiUsageFigures): AiUsageFigures => ({
  calls: a.calls + b.calls, units: a.units + b.units, tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut,
});
const ZERO: AiUsageFigures = { calls: 0, units: 0, tokensIn: 0, tokensOut: 0 };

interface Tally { accepted: number; editedAccepted: number; discarded: number }
const ZERO_TALLY: Tally = { accepted: 0, editedAccepted: 0, discarded: 0 };

/** (accepted + edited-then-accepted) / all outcomes, or null with none. */
export function acceptanceRate(t: Tally): number | null {
  const n = t.accepted + t.editedAccepted + t.discarded;
  return n > 0 ? (t.accepted + t.editedAccepted) / n : null;
}

function withAcceptance(t: Tally) {
  return { ...t, outcomes: t.accepted + t.editedAccepted + t.discarded, acceptanceRate: acceptanceRate(t) };
}

function addOutcome(t: Tally, outcome: unknown, n: number): Tally {
  if (outcome === 'accepted') return { ...t, accepted: t.accepted + n };
  if (outcome === 'edited_accepted') return { ...t, editedAccepted: t.editedAccepted + n };
  if (outcome === 'discarded') return { ...t, discarded: t.discarded + n };
  return t;
}

/** Build the report for one scope and range. */
export async function queryAiUsageReport(q: AiUsageReportQuery): Promise<AiUsageReport> {
  const scope = scopeMatch(q);
  const hour = { $gte: bucketHour(q.from), $lt: q.to };
  const bucketKey = bucketExpr(q.interval, q.tz, q.weekStart);

  const usageFacet: Record<string, PipelineStage.FacetPipelineStage[]> = {
    totals: [{ $group: { _id: null, ...USAGE_SUMS } }],
    buckets: [{ $group: { _id: bucketKey, ...USAGE_SUMS } }],
    callers: [{ $group: { _id: CALLER_TYPE_EXPR, ...USAGE_SUMS } }],
    features: [{ $group: { _id: '$feature', ...USAGE_SUMS } }],
    ...(q.rollup ? { teams: [{ $group: { _id: '$orgId', ...USAGE_SUMS } }, { $sort: { calls: -1, counted: -1 } }, { $limit: MAX_TEAMS }] } : {}),
  };

  const [usageRows, outcomeRows, first] = await Promise.all([
    UsageBucket.aggregate<Record<string, SumRow[]>>([
      { $match: { ...scope, quotaType: 'aiCalls', hour } },
      { $facet: usageFacet },
    ]),
    AiDraftOutcomeBucket.aggregate<Record<string, CountRow[]>>([
      { $match: { ...scope, hour } },
      {
        $facet: {
          totals: [{ $group: { _id: '$outcome', n: { $sum: '$count' } } }],
          buckets: [{ $group: { _id: { b: bucketKey, o: '$outcome' }, n: { $sum: '$count' } } }],
          features: [{ $group: { _id: { f: '$feature', o: '$outcome' }, n: { $sum: '$count' } } }],
        },
      },
    ]),
    AiDraftOutcomeBucket.findOne(scope).sort({ hour: 1 }).select('hour').lean() as Promise<{ hour?: Date } | null>,
  ]);
  const usage = usageRows[0] ?? {};
  const outcomes = outcomeRows[0] ?? {};

  // Totals.
  let totalTally = ZERO_TALLY;
  for (const r of outcomes.totals ?? []) totalTally = addOutcome(totalTally, r._id, r.n);
  const totals: AiUsageTotals = { ...figures(usage.totals?.[0]), ...withAcceptance(totalTally) };

  // Time buckets: the union of usage and outcome buckets.
  const bucketUsage = new Map<string, AiUsageFigures>();
  for (const r of usage.buckets ?? []) if (typeof r._id === 'string') bucketUsage.set(r._id, figures(r));
  const bucketTally = new Map<string, Tally>();
  for (const r of outcomes.buckets ?? []) {
    const id = r._id as { b?: unknown; o?: unknown } | null;
    if (typeof id?.b !== 'string') continue;
    bucketTally.set(id.b, addOutcome(bucketTally.get(id.b) ?? ZERO_TALLY, id.o, r.n));
  }
  const buckets: AiUsageBucketRow[] = [...new Set([...bucketUsage.keys(), ...bucketTally.keys()])].sort().map((bucket) => ({
    bucket,
    ...(bucketUsage.get(bucket) ?? ZERO),
    ...withAcceptance(bucketTally.get(bucket) ?? ZERO_TALLY),
  }));

  // Caller types, in catalog order.
  const callerUsage = new Map<string, AiUsageFigures>();
  for (const r of usage.callers ?? []) callerUsage.set(String(r._id), figures(r));
  const byCallerType: AiCallerTypeRow[] = AI_CALLER_TYPES
    .filter((t) => callerUsage.has(t))
    .map((callerType) => ({ callerType, ...callerUsage.get(callerType)! }));

  // Features, folded onto the catalog, in catalog order.
  const featureUsage = new Map<AiReportFeature, AiUsageFigures>();
  for (const r of usage.features ?? []) {
    const key = reportFeatureOf(typeof r._id === 'string' ? r._id : null);
    featureUsage.set(key, addFigures(featureUsage.get(key) ?? ZERO, figures(r)));
  }
  const featureTally = new Map<AiReportFeature, Tally>();
  for (const r of outcomes.features ?? []) {
    const id = r._id as { f?: unknown; o?: unknown } | null;
    const key = reportFeatureOf(typeof id?.f === 'string' ? id.f : null);
    featureTally.set(key, addOutcome(featureTally.get(key) ?? ZERO_TALLY, id?.o, r.n));
  }
  const byFeature: AiFeatureRow[] = (Object.keys(AI_REPORT_FEATURES) as AiReportFeature[])
    .filter((f) => featureUsage.has(f) || featureTally.has(f))
    .map((feature) => ({ feature, ...(featureUsage.get(feature) ?? ZERO), ...withAcceptance(featureTally.get(feature) ?? ZERO_TALLY) }));

  // Teams (rollup only), named from the shared organizations collection.
  let byTeam: AiTeamRow[] | null = null;
  if (q.rollup) {
    const rows = (usage.teams ?? []).filter((r) => typeof r._id === 'string');
    const ids = rows.map((r) => r._id as string);
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const orgs = await Organization.find({ _id: { $in: ids.map((id) => toOrgId(id)) } }).select('name').lean() as unknown as Array<{ _id: unknown; name?: unknown }>;
      for (const o of orgs) if (typeof o.name === 'string') names.set(String(o._id), o.name);
    }
    byTeam = rows
      .map((r) => ({ orgId: r._id as string, name: names.get(r._id as string) ?? null, ...figures(r) }))
      .sort((a, b) => b.calls - a.calls || b.units - a.units);
  }

  return {
    orgId: q.orgId,
    scope: q.rollup ? 'rollup' : 'org',
    from: q.from.toISOString(),
    to: q.to.toISOString(),
    interval: q.interval,
    tz: q.tz,
    weekStart: q.weekStart,
    retentionDays: config.quota.usageEventRetentionDays,
    acceptanceSince: first?.hour ? new Date(first.hour).toISOString() : null,
    totals,
    buckets,
    byCallerType,
    byTeam,
    byFeature,
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const CSV_HEADER = ['section', 'key', 'label', 'calls', 'units', 'tokensIn', 'tokensOut', 'accepted', 'editedAccepted', 'discarded', 'acceptanceRate'];

/**
 * The report as one CSV: a row per time bucket, caller type, team and feature
 * (`section` names which). Acceptance cells are blank where the slice has no
 * acceptance (caller types, teams); a rate with no outcomes is blank too.
 */
export function aiUsageReportToCsv(r: AiUsageReport): string {
  type Row = AiUsageFigures & Partial<Tally> & { acceptanceRate?: number | null };
  const line = (section: string, key: string, label: string, row: Row) => [
    section, key, label, row.calls, row.units, row.tokensIn, row.tokensOut,
    row.accepted ?? '', row.editedAccepted ?? '', row.discarded ?? '',
    row.acceptanceRate === null || row.acceptanceRate === undefined ? '' : Number(row.acceptanceRate.toFixed(4)),
  ].map(csvCell).join(',');
  return [
    CSV_HEADER.join(','),
    ...r.buckets.map((b) => line('bucket', b.bucket, b.bucket, b)),
    ...r.byCallerType.map((c) => line('caller_type', c.callerType, AI_CALLER_TYPE_LABELS[c.callerType], c)),
    ...(r.byTeam ?? []).map((t) => line('team', t.orgId, t.name ?? t.orgId, t)),
    ...r.byFeature.map((f) => line('feature', f.feature, AI_REPORT_FEATURES[f.feature], f)),
  ].join('\n');
}
