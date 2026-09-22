// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Data hooks for the Reports dashboard. Each top-level tab owns a cohesive hook
 * that reads exactly the slices it renders, keyed on the active filters.
 *
 * Every slice is one `useFetch` (or, for the reads other pages share —
 * execution counts and the pipeline list — one `useQuery` against the shared
 * cache), so cancellation, the superseded-request guard and loading/error state
 * live in those primitives rather than being hand-rolled per tab. A tab folds
 * its slices into ONE {@link TabDataStatus}: loading while any slice is, and the
 * first failed slice as an `error` string so a backend failure shows a banner
 * instead of masquerading as an empty ("No data yet") state.
 */

import { useCallback, useMemo } from 'react';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import { queries } from '@/lib/api-cache';
import type { ExecutionCountRow } from '@/types';
import type { DoraMetrics, DoraTrendPoint, DeploymentRow, BuildHealth, IngestHealthResponse, ReportRetention } from '@/lib/api/domains/reporting';
import type {
  TimelineEntry, DurationStat, StageBottleneck, StageFailure, ActionFailure, ErrorEntry,
  PluginSummary, PluginDistribution, BuildSuccessEntry, BuildDurationStat, BuildFailure, PluginRuntimeRow, PluginVersion,
} from './types';

// ─── Retention / effective-max ──────────────────────────

/** Fallback caps applied until (or if) the org's effective retention can't be
 *  read (mirrors the backend env defaults). */
const DEFAULT_EVENT_RETENTION_DAYS = 30;
const DEFAULT_DORA_RETENTION_DAYS = 180;

/**
 * The per-tab effective date-range cap, read from `GET /reports/retention` —
 * `reports:read` only, so an org with a Retention Pack but no Advanced Reporting
 * still gets the horizon it bought (the incident settings carry the same numbers
 * but sit behind the DORA entitlement). Falls back to the env defaults (30 / 180)
 * when the read fails — the caller clamps the requested range to the max so the
 * frontend never issues an over-range request.
 */
export function useReportRetention(): ReportRetention {
  const { data } = useFetch(async (signal) => (await api.getReportRetention({ signal })) ?? null, []);
  return useMemo(() => ({
    eventRetentionDays: data?.eventRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS,
    doraRetentionDays: data?.doraRetentionDays ?? DEFAULT_DORA_RETENTION_DAYS,
    eventMaxRangeDays: data?.eventMaxRangeDays ?? DEFAULT_EVENT_RETENTION_DAYS,
    doraMaxRangeDays: data?.doraMaxRangeDays ?? DEFAULT_DORA_RETENTION_DAYS,
  }), [data]);
}

// ─── Ingestion freshness ────────────────────────────────

/** State of the ingest-health read backing the freshness strip. */
export interface IngestHealthState {
  data: IngestHealthResponse | null | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Read this org's ingestion health once on mount (and on demand). Kept separate
 * from the per-tab hooks because it is range-independent: it answers "is the
 * pipeline that feeds these reports alive?", not "what happened in this window?".
 *
 * `data === undefined` means "not read yet / failed"; `data.health === null`
 * means the org has genuinely never had ingestion reported. The strip renders
 * nothing for the former and says so plainly for the latter.
 */
export function useIngestHealth(): IngestHealthState {
  // Optional-chain so a test that doesn't mock the method yields undefined
  // rather than throwing.
  const { data, loading, error, refetch } = useFetch(
    async (signal) => (await api.getIngestHealth?.({ signal })) ?? null,
    [],
  );
  return {
    data: data ?? undefined,
    loading,
    error: error ? formatError(error, 'Failed to read ingestion health') : null,
    reload: refetch,
  };
}

// ─── Shared filter shape ────────────────────────────────

/** Filters shared by every tab's fetch (already clamped to the tab's cap). */
export interface SharedFilters {
  /** Clamped `YYYY-MM-DD` window start, or '' (omitted ⇒ backend default). */
  dateFrom: string;
  dateTo: string;
  interval: 'day' | 'week' | 'month';
  /** Org → team rollup. Sent to EVERY rollup-aware report, so all panels share one scope. */
  includeDescendants: boolean;
  /** The viewer is a system admin: the error-pattern / build-failure reports are
   *  sysadmin-only on the backend, so nobody else requests them (a 403 there
   *  would otherwise raise the tab's error banner for every org admin). */
  systemAdmin?: boolean;
}

/** The `{from,to,includeDescendants}` query bag, omitting empty/false values. */
interface RangeParams { from?: string; to?: string; includeDescendants?: boolean }

function rangeParamsOf({ dateFrom, dateTo, includeDescendants }: SharedFilters): RangeParams {
  const p: RangeParams = {};
  if (dateFrom) p.from = dateFrom;
  if (dateTo) p.to = dateTo;
  if (includeDescendants) p.includeDescendants = true;
  return p;
}

export interface TabDataStatus {
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** The status half of a `useFetch` / `useQuery` result. */
interface SliceStatus {
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * One report read. While `active` is false it resolves `null` without touching
 * the network (the sub-tab isn't showing it); `key` is the dependency that
 * re-issues it — the fetcher itself may be rebuilt every render.
 */
function useSlice<T>(active: boolean, key: string, run: (signal: AbortSignal) => Promise<T>) {
  return useFetch<T | null>((signal) => (active ? run(signal) : Promise.resolve(null)), [active, key]);
}

/** Fold a tab's slices into its one loading / first-error / refetch-all status. */
function useTabStatus(slices: SliceStatus[]): TabDataStatus {
  const loading = slices.some((s) => s.loading);
  const failed = slices.find((s) => s.error)?.error ?? null;
  const refetchers = slices.map((s) => s.refetch);
  // The individual refetches are stable, so this is too — which matters: tabs
  // report it up through an effect keyed on its identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the dep list IS the slice refetchers array — dynamic by construction
  const refetch = useCallback(() => { refetchers.forEach((r) => r()); }, refetchers);
  return { loading, error: failed ? formatError(failed, 'Failed to load report data') : null, refetch };
}

/** A best-effort slice: its failure never trips the shared error banner. */
function quiet(slice: SliceStatus): SliceStatus {
  return { ...slice, error: null };
}

// ─── Pipelines tab ──────────────────────────────────────

export type PipelineSubTab = 'overview' | 'performance' | 'failures';

export interface PipelinesData extends TabDataStatus {
  executions: ExecutionCountRow[];
  timeline: TimelineEntry[];
  durations: DurationStat[];
  bottlenecks: StageBottleneck[];
  stageFailures: StageFailure[];
  actionFailures: ActionFailure[];
  errors: ErrorEntry[];
}

export function usePipelinesData(subTab: PipelineSubTab, filters: SharedFilters): PipelinesData {
  const range = rangeParamsOf(filters);
  const key = JSON.stringify(range);
  const { interval } = filters;
  const overview = subTab === 'overview';
  const performance = subTab === 'performance';
  const failures = subTab === 'failures';

  // Execution counts are shared with the executions page / DORA tab via the cache.
  const exec = useQuery(!failures ? queries.executionCount(range) : null);
  const timeline = useSlice(overview, `${key}|${interval}`, async (signal) =>
    (await api.getSuccessRate({ interval, ...range }, { signal })).data?.timeline ?? []);
  const durations = useSlice(performance, key, async (signal) =>
    (await api.getPipelineDuration(range, { signal })).data?.pipelines ?? []);
  const bottlenecks = useSlice(performance, key, async (signal) =>
    (await api.getStageBottlenecks(range, { signal })).data?.stages ?? []);
  const stageFailures = useSlice(failures, key, async (signal) =>
    (await api.getStageFailures(range, { signal })).data?.stages ?? []);
  const actionFailures = useSlice(failures, key, async (signal) =>
    (await api.getActionFailures(range, { signal })).data?.actions ?? []);
  const errors = useSlice(failures && !!filters.systemAdmin, key, async (signal) =>
    (await api.getExecutionErrors({ limit: 10, ...range }, { signal })).data?.errors ?? []);

  const status = useTabStatus([exec, timeline, durations, bottlenecks, stageFailures, actionFailures, errors]);

  return {
    executions: exec.data?.data?.pipelines ?? [],
    timeline: timeline.data ?? [],
    durations: durations.data ?? [],
    bottlenecks: bottlenecks.data ?? [],
    stageFailures: stageFailures.data ?? [],
    actionFailures: actionFailures.data ?? [],
    errors: errors.data ?? [],
    ...status,
  };
}

// ─── Plugins tab ────────────────────────────────────────

export type PluginSubTab = 'overview' | 'builds' | 'runs' | 'versions';

export interface PluginsData extends TabDataStatus {
  pluginSummary: PluginSummary | null;
  distribution: PluginDistribution[];
  buildTimeline: BuildSuccessEntry[];
  buildDurations: BuildDurationStat[];
  buildFailures: BuildFailure[];
  pluginRuntime: PluginRuntimeRow[];
  pluginVersions: PluginVersion[];
}

/** Join the two runtime routes (each projects half of one aggregate) on publisher/name/version. */
export function joinPluginRuntime(
  rates: Array<Omit<PluginRuntimeRow, 'p50Ms' | 'p95Ms'>>,
  durations: Array<Pick<PluginRuntimeRow, 'pluginPublisher' | 'pluginName' | 'pluginVersion' | 'p50Ms' | 'p95Ms'>>,
): PluginRuntimeRow[] {
  const key = (r: { pluginPublisher: string | null; pluginName: string; pluginVersion: string }) =>
    `${r.pluginPublisher ?? ''}/${r.pluginName}@${r.pluginVersion}`;
  const byKey = new Map(durations.map((d) => [key(d), d]));
  return rates
    .map((r) => {
      const d = byKey.get(key(r));
      return { ...r, p50Ms: d?.p50Ms ?? null, p95Ms: d?.p95Ms ?? null };
    })
    .sort((a, b) => b.runs - a.runs);
}

export function usePluginsData(subTab: PluginSubTab, filters: SharedFilters): PluginsData {
  // Build reports are rollup-aware; the inventory reports (summary /
  // distribution / versions) are single-org by design and take no range.
  const range = rangeParamsOf(filters);
  const key = JSON.stringify(range);
  const { interval } = filters;
  const overview = subTab === 'overview';
  const builds = subTab === 'builds';

  const summary = useSlice(overview, '', async (signal) =>
    (await api.getPluginSummary({ signal })).data?.summary ?? null);
  const distribution = useSlice(overview, '', async (signal) =>
    (await api.getPluginDistribution({ signal })).data?.distribution ?? []);
  const buildTimeline = useSlice(builds, `${key}|${interval}`, async (signal) =>
    (await api.getBuildSuccessRate({ interval, ...range }, { signal })).data?.timeline ?? []);
  const buildDurations = useSlice(builds, key, async (signal) =>
    (await api.getBuildDuration(range, { signal })).data?.plugins ?? []);
  const buildFailures = useSlice(builds && !!filters.systemAdmin, key, async (signal) =>
    (await api.getBuildFailures({ limit: 10, ...range }, { signal })).data?.failures ?? []);
  const runtime = useSlice(subTab === 'runs', key, async (signal) => {
    const [rates, durations] = await Promise.all([
      api.getPluginRuntimeSuccessRate(range, { signal }),
      api.getPluginRuntimeDuration(range, { signal }),
    ]);
    return joinPluginRuntime(rates.data?.plugins ?? [], durations.data?.plugins ?? []);
  });
  const versions = useSlice(subTab === 'versions', '', async (signal) =>
    (await api.getPluginVersions({ signal })).data?.plugins ?? []);

  const status = useTabStatus([summary, distribution, buildTimeline, buildDurations, buildFailures, runtime, versions]);

  return {
    pluginSummary: summary.data ?? null,
    distribution: distribution.data ?? [],
    buildTimeline: buildTimeline.data ?? [],
    buildDurations: buildDurations.data ?? [],
    buildFailures: buildFailures.data ?? [],
    pluginRuntime: runtime.data ?? [],
    pluginVersions: versions.data ?? [],
    ...status,
  };
}

// ─── DORA tab ───────────────────────────────────────────

export interface DoraFilters extends SharedFilters {
  /** Whether `advanced_reporting` is entitled — gates the fetch (no pointless 403). */
  enabled: boolean;
  /** Scoped pipeline id (''=org-wide). */
  pipelineId: string;
  /** Committed environment filter (''=all). */
  environmentApplied: string;
}

export interface DoraData extends TabDataStatus {
  dora: DoraMetrics | null;
  doraTrend: DoraTrendPoint[];
  executions: ExecutionCountRow[];
  pipelineOptions: { id: string; name: string }[];
  environmentOptions: string[];
  deployments: DeploymentRow[];
  buildHealth: BuildHealth | null;
}

export function useDoraData(filters: DoraFilters): DoraData {
  const { interval, enabled, pipelineId, environmentApplied } = filters;
  const range = rangeParamsOf(filters);
  const key = JSON.stringify(range);
  const scope: { pipelineId?: string; environment?: string } = {};
  if (pipelineId) scope.pipelineId = pipelineId;
  if (environmentApplied.trim()) scope.environment = environmentApplied.trim();
  const scopeKey = `${key}|${JSON.stringify(scope)}`;
  // Per-pipeline aux reads (deploy list + build health) key on a pipelineId, so
  // they only fire once a single pipeline is scoped.
  const scoped = enabled && !!pipelineId;

  // Non-entitled: the tab renders the upsell teaser — no read fires (avoids a
  // pointless 403), and there is nothing to load.
  const dora = useSlice(enabled, scopeKey, async (signal) =>
    (await api.getDora({ ...range, ...scope }, { signal })) ?? null);
  const doraTrend = useSlice(enabled, `${scopeKey}|${interval}`, (signal) =>
    api.getDoraTrend({ interval, ...range, ...scope }, { signal }));
  const exec = useQuery(enabled ? queries.executionCount(range) : null);
  // The rest are best-effort pickers / aux panels: a failure leaves them empty
  // rather than raising the shared banner.
  const pipelines = useQuery(enabled ? queries.listPipelines({ limit: '200' }) : null);
  const environments = useSlice(enabled, key, async (signal) =>
    (await api.getReportEnvironments(range, { signal })).data?.environments ?? []);
  const deployments = useSlice(scoped, `${key}|${pipelineId}`, async (signal) =>
    (await api.listPipelineExecutions(pipelineId, { ...range, limit: 25 }, { signal })).data?.executions ?? []);
  const buildHealth = useSlice(scoped, `${key}|${pipelineId}`, async (signal) =>
    (await api.getBuildHealth(pipelineId, range, { signal })) ?? null);

  const status = useTabStatus([
    dora, doraTrend, exec, quiet(pipelines), quiet(environments), quiet(deployments), quiet(buildHealth),
  ]);

  const pipelineRows = pipelines.data?.data?.pipelines;
  const pipelineOptions = useMemo(
    () => (pipelineRows ?? []).map((p) => ({ id: p.id, name: p.pipelineName || p.project })),
    [pipelineRows],
  );

  return {
    dora: dora.data ?? null,
    doraTrend: doraTrend.data ?? [],
    executions: exec.data?.data?.pipelines ?? [],
    pipelineOptions,
    environmentOptions: environments.error ? [] : environments.data ?? [],
    deployments: deployments.error ? [] : deployments.data ?? [],
    buildHealth: buildHealth.error ? null : buildHealth.data ?? null,
    ...status,
  };
}
