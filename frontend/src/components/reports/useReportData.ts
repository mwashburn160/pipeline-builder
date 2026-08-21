// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Data hooks for the Reports dashboard. Each top-level tab owns a cohesive hook
 * that fetches exactly the slices it renders, keyed on the active filters — this
 * replaces the page's single giant fetch effect + ~40 useStates. Every hook
 * keeps the request-generation guard (a superseded fetch never writes state) and
 * surfaces the first rejected fetch as an `error` string so a backend failure
 * shows a banner instead of masquerading as an empty ("No data yet") state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { ExecutionCountRow } from '@/types';
import type { DoraMetrics, DoraTrendPoint, DeploymentRow, BuildHealth } from '@/lib/api/domains/reporting';
import type {
  TimelineEntry, DurationStat, StageBottleneck, StageFailure, ActionFailure, ErrorEntry,
  PluginSummary, PluginDistribution, BuildSuccessEntry, BuildDurationStat, BuildFailure, PluginVersion,
} from './types';

// ─── Retention / effective-max ──────────────────────────

/** Fallback caps applied when the per-org retention settings are unavailable or
 *  the viewer isn't entitled to read them (mirrors the backend env defaults). */
export const DEFAULT_EVENT_RETENTION_DAYS = 30;
export const DEFAULT_DORA_RETENTION_DAYS = 180;

export interface ReportRetention {
  /** Max selectable window (days) for standard event routes (Pipelines/Plugins). */
  eventMax: number;
  /** Max selectable window (days) for DORA routes. */
  doraMax: number;
}

/**
 * The per-tab effective date-range cap, read once from `getIncidentSettings`
 * (best-effort). Standard event routes cap at the org's event retention; DORA
 * routes cap at its DORA retention. Falls back to the env defaults (30 / 180)
 * when the settings can't be read (non-entitled / offline) — the caller clamps
 * the requested range to this so the frontend never issues an over-range request.
 */
export function useReportRetention(): ReportRetention {
  const [retention, setRetention] = useState<ReportRetention>({
    eventMax: DEFAULT_EVENT_RETENTION_DAYS,
    doraMax: DEFAULT_DORA_RETENTION_DAYS,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Optional-chain the call so a client build without the method (or a test
        // that doesn't mock it) yields `undefined` rather than throwing.
        const s = await api.getIncidentSettings?.();
        if (cancelled || !s) return;
        setRetention({
          eventMax: s.eventRetentionDays ?? s.defaultEventRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS,
          doraMax: s.doraRetentionDays ?? s.defaultDoraRetentionDays ?? DEFAULT_DORA_RETENTION_DAYS,
        });
      } catch {
        /* fail-soft: keep the defaults */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return retention;
}

// ─── Shared filter shape ────────────────────────────────

/** Filters shared by every tab's fetch (already clamped to the tab's cap). */
export interface SharedFilters {
  /** Clamped `YYYY-MM-DD` window start, or '' (omitted ⇒ backend default). */
  dateFrom: string;
  dateTo: string;
  interval: 'day' | 'week' | 'month';
  includeDescendants: boolean;
}

/** Build the `{from,to}` query bag, omitting empty bounds. */
function dateParamsOf(dateFrom: string, dateTo: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (dateFrom) p.from = dateFrom;
  if (dateTo) p.to = dateTo;
  return p;
}

/** First rejected settled result → error string (else null). */
function firstError(settled: PromiseSettledResult<unknown>[]): string | null {
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  return rejected ? formatError(rejected.reason, 'Failed to load report data') : null;
}

export interface TabDataStatus {
  loading: boolean;
  error: string | null;
  refetch: () => void;
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
  const { dateFrom, dateTo, interval, includeDescendants } = filters;
  const [executions, setExecutions] = useState<ExecutionCountRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [durations, setDurations] = useState<DurationStat[]>([]);
  const [bottlenecks, setBottlenecks] = useState<StageBottleneck[]>([]);
  const [stageFailures, setStageFailures] = useState<StageFailure[]>([]);
  const [actionFailures, setActionFailures] = useState<ActionFailure[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const refetch = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const dateParams = dateParamsOf(dateFrom, dateTo);
    const rollup = includeDescendants ? { includeDescendants: true } : {};
    let settled: PromiseSettledResult<unknown>[] = [];
    try {
      if (subTab === 'overview') {
        const results = await Promise.allSettled([
          api.getExecutionCount({ ...dateParams, ...rollup }),
          api.getSuccessRate({ interval, ...dateParams, ...rollup }),
        ]);
        if (reqId !== reqIdRef.current) return;
        settled = results;
        const [execRes, successRateRes] = results;
        if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
        if (successRateRes.status === 'fulfilled') setTimeline(successRateRes.value.data?.timeline || []);
      } else if (subTab === 'performance') {
        const results = await Promise.allSettled([
          api.getExecutionCount({ ...dateParams, ...rollup }),
          api.getPipelineDuration({ ...dateParams, ...rollup }),
          api.getStageBottlenecks(dateParams),
        ]);
        if (reqId !== reqIdRef.current) return;
        settled = results;
        const [execRes, durationRes, bottleneckRes] = results;
        if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
        if (durationRes.status === 'fulfilled') setDurations(durationRes.value.data?.pipelines || []);
        if (bottleneckRes.status === 'fulfilled') setBottlenecks(bottleneckRes.value.data?.stages || []);
      } else {
        const results = await Promise.allSettled([
          api.getStageFailures(dateParams),
          api.getActionFailures(dateParams),
          api.getExecutionErrors({ limit: 10, ...dateParams }),
        ]);
        if (reqId !== reqIdRef.current) return;
        settled = results;
        const [stageRes, actionRes, errorRes] = results;
        if (stageRes.status === 'fulfilled') setStageFailures(stageRes.value.data?.stages || []);
        if (actionRes.status === 'fulfilled') setActionFailures(actionRes.value.data?.actions || []);
        if (errorRes.status === 'fulfilled') setErrors(errorRes.value.data?.errors || []);
      }
      setError(firstError(settled));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [subTab, dateFrom, dateTo, interval, includeDescendants]);

  useEffect(() => { void refetch(); }, [refetch]);

  return { executions, timeline, durations, bottlenecks, stageFailures, actionFailures, errors, loading, error, refetch };
}

// ─── Plugins tab ────────────────────────────────────────

export type PluginSubTab = 'overview' | 'builds' | 'versions';

export interface PluginsData extends TabDataStatus {
  pluginSummary: PluginSummary | null;
  distribution: PluginDistribution[];
  buildTimeline: BuildSuccessEntry[];
  buildDurations: BuildDurationStat[];
  buildFailures: BuildFailure[];
  pluginVersions: PluginVersion[];
}

export function usePluginsData(subTab: PluginSubTab, filters: SharedFilters): PluginsData {
  const { dateFrom, dateTo, interval } = filters;
  const [pluginSummary, setPluginSummary] = useState<PluginSummary | null>(null);
  const [distribution, setDistribution] = useState<PluginDistribution[]>([]);
  const [buildTimeline, setBuildTimeline] = useState<BuildSuccessEntry[]>([]);
  const [buildDurations, setBuildDurations] = useState<BuildDurationStat[]>([]);
  const [buildFailures, setBuildFailures] = useState<BuildFailure[]>([]);
  const [pluginVersions, setPluginVersions] = useState<PluginVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const refetch = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const dateParams = dateParamsOf(dateFrom, dateTo);
    let settled: PromiseSettledResult<unknown>[] = [];
    try {
      if (subTab === 'overview') {
        const results = await Promise.allSettled([api.getPluginSummary(), api.getPluginDistribution()]);
        if (reqId !== reqIdRef.current) return;
        settled = results;
        const [sumRes, distRes] = results;
        if (sumRes.status === 'fulfilled') setPluginSummary(sumRes.value.data?.summary || null);
        if (distRes.status === 'fulfilled') setDistribution(distRes.value.data?.distribution || []);
      } else if (subTab === 'builds') {
        const results = await Promise.allSettled([
          api.getBuildSuccessRate({ interval, ...dateParams }),
          api.getBuildDuration(dateParams),
          api.getBuildFailures({ limit: 10, ...dateParams }),
        ]);
        if (reqId !== reqIdRef.current) return;
        settled = results;
        const [timelineRes, durRes, failRes] = results;
        if (timelineRes.status === 'fulfilled') setBuildTimeline(timelineRes.value.data?.timeline || []);
        if (durRes.status === 'fulfilled') setBuildDurations(durRes.value.data?.plugins || []);
        if (failRes.status === 'fulfilled') setBuildFailures(failRes.value.data?.failures || []);
      } else {
        const results = await Promise.allSettled([api.getPluginVersions()]);
        if (reqId !== reqIdRef.current) return;
        settled = results;
        const [verRes] = results;
        if (verRes.status === 'fulfilled') setPluginVersions(verRes.value.data?.plugins || []);
      }
      setError(firstError(settled));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [subTab, dateFrom, dateTo, interval]);

  useEffect(() => { void refetch(); }, [refetch]);

  return { pluginSummary, distribution, buildTimeline, buildDurations, buildFailures, pluginVersions, loading, error, refetch };
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
  const { dateFrom, dateTo, interval, includeDescendants, enabled, pipelineId, environmentApplied } = filters;
  const [dora, setDora] = useState<DoraMetrics | null>(null);
  const [doraTrend, setDoraTrend] = useState<DoraTrendPoint[]>([]);
  const [executions, setExecutions] = useState<ExecutionCountRow[]>([]);
  const [pipelineOptions, setPipelineOptions] = useState<{ id: string; name: string }[]>([]);
  const [environmentOptions, setEnvironmentOptions] = useState<string[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [buildHealth, setBuildHealth] = useState<BuildHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const refetch = useCallback(async () => {
    // Non-entitled: the tab renders the upsell teaser — no fetch fires (avoids a
    // pointless 403), and there is nothing to load.
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const dateParams = dateParamsOf(dateFrom, dateTo);
    const rollup = includeDescendants ? { includeDescendants: true } : {};
    const doraScope: { pipelineId?: string; environment?: string } = {};
    if (pipelineId) doraScope.pipelineId = pipelineId;
    if (environmentApplied.trim()) doraScope.environment = environmentApplied.trim();
    // Per-pipeline aux fetches (deploy list + build health) only fire when a
    // single pipeline is scoped — their endpoints key on a pipelineId. Best-effort:
    // swallow failures so they never trip the shared error banner.
    const deployListReq = pipelineId
      ? api.listPipelineExecutions(pipelineId, { ...dateParams, ...rollup, limit: 25 }).catch(() => undefined)
      : Promise.resolve(undefined);
    const buildHealthReq = pipelineId
      ? api.getBuildHealth(pipelineId, { ...dateParams, ...rollup }).catch(() => undefined)
      : Promise.resolve(undefined);
    let settled: PromiseSettledResult<unknown>[] = [];
    try {
      const results = await Promise.allSettled([
        api.getDora({ ...dateParams, ...rollup, ...doraScope }),
        api.getDoraTrend({ interval, ...dateParams, ...rollup, ...doraScope }),
        api.getExecutionCount({ ...dateParams, ...rollup }),
        api.listPipelines({ limit: '200' }).catch(() => undefined),
        api.getReportEnvironments({ ...dateParams, ...rollup }).catch(() => undefined),
        deployListReq,
        buildHealthReq,
      ]);
      if (reqId !== reqIdRef.current) return;
      settled = results;
      const [doraRes, doraTrendRes, execRes, pipelineListRes, envListRes, deployRes, buildHealthRes] = results;
      if (doraRes.status === 'fulfilled') setDora(doraRes.value ?? null);
      if (doraTrendRes.status === 'fulfilled') setDoraTrend(doraTrendRes.value ?? []);
      if (execRes.status === 'fulfilled') setExecutions(execRes.value.data?.pipelines || []);
      if (pipelineListRes.status === 'fulfilled' && pipelineListRes.value) {
        setPipelineOptions(
          (pipelineListRes.value.data?.pipelines ?? []).map((p) => ({ id: p.id, name: p.pipelineName || p.project })),
        );
      }
      if (envListRes.status === 'fulfilled' && envListRes.value) {
        setEnvironmentOptions(envListRes.value.data?.environments ?? []);
      }
      setDeployments(
        deployRes.status === 'fulfilled' && deployRes.value ? deployRes.value.data?.executions ?? [] : [],
      );
      setBuildHealth(
        buildHealthRes.status === 'fulfilled' && buildHealthRes.value ? buildHealthRes.value : null,
      );
      setError(firstError(settled));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [enabled, dateFrom, dateTo, interval, includeDescendants, pipelineId, environmentApplied]);

  useEffect(() => { void refetch(); }, [refetch]);

  return { dora, doraTrend, executions, pipelineOptions, environmentOptions, deployments, buildHealth, loading, error, refetch };
}
