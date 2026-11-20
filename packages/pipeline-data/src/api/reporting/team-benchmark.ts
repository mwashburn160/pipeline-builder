// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Team benchmarking: one row per team in an org → team hierarchy, plus the
 * parent org itself, with the four DORA measures, the success rate and the run
 * count over one window.
 *
 * Each row is computed by calling the SAME service reads the team's own
 * dashboard calls — `getDoraMetrics` and `getSuccessRate` — for that team's org
 * id alone (no rollup), inside THAT team's tenant scope, with the team's own
 * incident-correlation window. So a team's benchmark row and the numbers on
 * that team's DORA and Pipelines tabs cannot drift: there is one implementation.
 * The parent's row is the parent's OWN figures (what its dashboard shows without
 * "Include child teams"), not the rollup.
 *
 * Team level only. Nothing here is per person, and nothing may become so: a
 * benchmark that ranks individuals describes a person, not a system.
 *
 * A team whose read fails gets a `failed` row instead of failing the table — one
 * unhealthy team must not blank the other twenty. The reason is logged, never
 * returned.
 */

import { createLogger, type DoraLevel, type WeekStart } from '@pipeline-builder/api-core';
import type { BucketOptions, DoraMetrics, DoraOptions, ReportingSettings, TimeSeriesEntry } from './types.js';
import { runWithTenantContext } from '../../database/tenancy.js';

const logger = createLogger('reporting-team-benchmark');

/** The service reads a benchmark row is built from (the dashboard's own). */
export interface TeamBenchmarkSource {
  getDoraMetrics(orgId: string, from: string, to: string, orgIds?: string[], opts?: DoraOptions): Promise<DoraMetrics>;
  getSuccessRate(
    orgId: string, interval: string, from: string, to: string, orgIds?: string[], bucket?: BucketOptions,
  ): Promise<TimeSeriesEntry[]>;
  getReportingSettings(orgId: string, retentionOrgId?: string): Promise<ReportingSettings>;
}

/** What one benchmark read covers. */
export interface TeamBenchmarkInput {
  /** The org the caller is acting as (the hierarchy's parent for this read). */
  parentOrgId: string;
  /** Every org in the table: `[parent, ...descendants]`, as the platform resolved it. */
  orgIds: string[];
  /** Lowercased org id → display name (best-effort; absent ids render as the id). */
  names?: Record<string, string>;
  /** The DORA window (capped + floored to the DORA retention, as /execution/dora does). */
  doraRange: { from: string; to: string };
  /** The success-rate window (capped + floored to the event retention, as /execution/success-rate does). */
  eventRange: { from: string; to: string };
  /** Success-rate bucket interval. The totals do not depend on it; it keeps the dashboard's cache key. */
  interval?: string;
  tz: string;
  weekStart: WeekStart;
  /** Teams read concurrently (default 4) — bounded so a large tree cannot flood the pool. */
  concurrency?: number;
}

/** A DORA measure as a benchmark cell: the value, its band and the sample it rests on. */
export interface BenchmarkCell<V> {
  value: V;
  /** `insufficient` when `n` is under MIN_DORA_SAMPLE; null when there is no sample. */
  level: DoraLevel;
  n: number;
}

/** Success rate over the window, from the success-rate report's buckets. */
export interface BenchmarkSuccess {
  /** Succeeded ÷ (succeeded + failed + canceled) × 100, one decimal; null with no runs. */
  pct: number | null;
  runs: number;
  succeeded: number;
  failed: number;
  canceled: number;
}

export interface TeamBenchmarkRow {
  orgId: string;
  name: string | null;
  /** `parent` = the org the table was read for; `team` = a descendant. */
  role: 'parent' | 'team';
  /** `failed` = this org's reads failed; its figures are absent. */
  state: 'ok' | 'failed';
  /** The headline environment the DORA cells describe (as the DORA tab picks it), or null when none deployed. */
  environment: string | null;
  /** Successful deploys and deploys per day. */
  deploymentFrequency: BenchmarkCell<{ deployments: number; perDay: number }> | null;
  /** Change failure rate (%) and attempts. */
  changeFailureRate: BenchmarkCell<{ rate: number; attempts: number }> | null;
  /** Median commit → deploy seconds (null = unknown). */
  leadTime: BenchmarkCell<{ medianSeconds: number | null }> | null;
  /** Median time to restore seconds (production-only, like the DORA tab). */
  timeToRestore: BenchmarkCell<{ medianSeconds: number | null }> | null;
  successRate: BenchmarkSuccess | null;
}

export interface TeamBenchmark {
  window: {
    dora: { from: string; to: string };
    events: { from: string; to: string };
    tz: string;
    weekStart: WeekStart;
  };
  /** Parent first, then teams in the order given (the frontend sorts). */
  rows: TeamBenchmarkRow[];
}

/** Sum a success-rate timeline into one window total — the dashboard's arithmetic. */
export function successTotals(timeline: readonly TimeSeriesEntry[]): BenchmarkSuccess {
  let succeeded = 0;
  let failed = 0;
  let canceled = 0;
  for (const t of timeline) {
    succeeded += Number(t.succeeded) || 0;
    failed += Number(t.failed) || 0;
    canceled += Number(t.canceled) || 0;
  }
  const runs = succeeded + failed + canceled;
  return {
    pct: runs > 0 ? Math.round((succeeded / runs) * 1000) / 10 : null,
    runs,
    succeeded,
    failed,
    canceled,
  };
}

/**
 * The headline environment's DORA cells, picked exactly as the DORA tab picks
 * its cards: the environment named by `headline`, else the first (the list is
 * sorted headline-first).
 */
function doraCells(dora: DoraMetrics): Pick<TeamBenchmarkRow, 'environment' | 'deploymentFrequency' | 'changeFailureRate' | 'leadTime' | 'timeToRestore'> {
  const env = dora.environments.find((e) => e.environment === dora.headline) ?? dora.environments[0] ?? null;
  const mttr = dora.meanTimeToRestore;
  return {
    environment: env?.environment ?? null,
    deploymentFrequency: env ? {
      value: { deployments: env.deploymentFrequency.deployments, perDay: env.deploymentFrequency.perDay },
      level: env.deploymentFrequency.level,
      n: env.deploymentFrequency.n,
    } : null,
    changeFailureRate: env ? {
      value: { rate: env.changeFailureRate.rate, attempts: env.changeFailureRate.attempts },
      level: env.changeFailureRate.level,
      n: env.changeFailureRate.n,
    } : null,
    leadTime: env ? {
      value: { medianSeconds: env.leadTime.medianSeconds },
      level: env.leadTime.level,
      n: env.leadTime.n,
    } : null,
    timeToRestore: { value: { medianSeconds: mttr.medianSeconds }, level: mttr.level, n: mttr.n },
  };
}

/**
 * One org's row, read in THAT org's tenant scope (the scope its own dashboard
 * runs in) and for that org alone.
 */
async function rowFor(source: TeamBenchmarkSource, orgId: string, input: TeamBenchmarkInput): Promise<TeamBenchmarkRow> {
  const role: TeamBenchmarkRow['role'] = orgId.toLowerCase() === input.parentOrgId.toLowerCase() ? 'parent' : 'team';
  const name = input.names?.[orgId.toLowerCase()] ?? null;
  try {
    return await runWithTenantContext({ orgId, isSuperAdmin: false }, async () => {
      // The team's own incident window, as its /execution/dora read resolves it.
      const settings = await source.getReportingSettings(orgId);
      const [dora, timeline] = await Promise.all([
        source.getDoraMetrics(orgId, input.doraRange.from, input.doraRange.to, undefined, {
          incidentWindowHours: settings.incidentWindowHours ?? undefined,
        }),
        source.getSuccessRate(orgId, input.interval ?? 'week', input.eventRange.from, input.eventRange.to, undefined, {
          tz: input.tz, weekStart: input.weekStart,
        }),
      ]);
      return { orgId, name, role, state: 'ok' as const, ...doraCells(dora), successRate: successTotals(timeline) };
    });
  } catch (err) {
    logger.warn('Team benchmark row failed; isolating it', { orgId, err: String(err) });
    return {
      orgId,
      name,
      role,
      state: 'failed',
      environment: null,
      deploymentFrequency: null,
      changeFailureRate: null,
      leadTime: null,
      timeToRestore: null,
      successRate: null,
    };
  }
}

/**
 * Build the benchmark table: the parent's own row, then one per descendant.
 * Duplicate ids are read once; the parent is always present even when the
 * resolved list omits it.
 */
export async function computeTeamBenchmark(source: TeamBenchmarkSource, input: TeamBenchmarkInput): Promise<TeamBenchmark> {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [input.parentOrgId, ...input.orgIds]) {
    const k = id.toLowerCase();
    if (!id || seen.has(k)) continue;
    seen.add(k);
    ids.push(id);
  }
  const limit = Math.max(1, input.concurrency ?? 4);
  const rows: TeamBenchmarkRow[] = new Array(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, async () => {
    while (next < ids.length) {
      const i = next++;
      rows[i] = await rowFor(source, ids[i], input);
    }
  }));
  return {
    window: { dora: input.doraRange, events: input.eventRange, tz: input.tz, weekStart: input.weekStart },
    rows,
  };
}

/**
 * The equal-length window immediately BEFORE a closed `[from, to]` dashboard
 * window — what `?compare=previous` reads. The DORA and success-rate reads are
 * inclusive at both ends, so the previous window ends one millisecond before
 * `from`: an event exactly on the boundary counts in one window, not both.
 * Returns null for an unparseable window.
 */
export function previousDashboardWindow(from: string, to: string): { from: string; to: string } | null {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) return null;
  const prevTo = f - 1;
  return { from: new Date(prevTo - (t - f)).toISOString(), to: new Date(prevTo).toISOString() };
}
