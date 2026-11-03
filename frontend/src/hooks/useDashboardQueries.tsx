// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import type { ObservabilityBatchQuery, ObservabilityBatchSlot, RangeKey } from '@/types/observability';
import { useReportPanelHealth } from './useObservabilityHealth';
import { usePolling } from './usePolling';

/**
 * Dashboard refresh cadence. Every request spends one `apiCalls`, so the
 * dashboard refreshes as ONE batched request per tick (not one per panel), and
 * no faster than once a minute — Prometheus scrapes every 15-30s, so a tighter
 * tick mostly re-reads identical samples while still billing the org.
 */
export const DASHBOARD_REFRESH_MS = 60_000;

/** What a panel asks for — a batch query minus its id (the id is derived from it). */
export type PanelQuerySpec = Omit<ObservabilityBatchQuery, 'id'>;

interface DashboardQueries {
  /** Add a query to the batch; returns the matching unregister. Ref-counted per id. */
  register: (id: string, spec: PanelQuerySpec) => () => void;
  results: Record<string, ObservabilityBatchSlot>;
  /** The whole batch failed (network, 401/403/429) — every panel shows it. */
  error: Error | null;
}

const DashboardQueriesContext = createContext<DashboardQueries | null>(null);

interface Registration { spec: PanelQuerySpec; refs: number }

/**
 * Owns every panel query on one dashboard and refreshes them TOGETHER:
 * one `POST /observability/query/batch` per tick, so a ten-panel dashboard costs
 * one API call per minute instead of ten every 30s. Panels register what they
 * need through {@link useDashboardPanelQuery}; identical queries from two panels
 * share one slot.
 *
 * Polling is {@link usePolling}'s: skipped while the tab is hidden, and one
 * refresh as soon as it is visible again. Panels mounting together (first
 * render, a range change) coalesce into a single request.
 */
export function DashboardQueryProvider({
  range,
  intervalMs = DASHBOARD_REFRESH_MS,
  children,
}: { range: RangeKey; intervalMs?: number; children: ReactNode }) {
  const registry = useRef<Map<string, Registration>>(new Map());
  const [results, setResults] = useState<Record<string, ObservabilityBatchSlot>>({});
  const [error, setError] = useState<Error | null>(null);
  // Bumped when the SET of queries changes, which schedules one coalesced fetch.
  const [generation, setGeneration] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const report = useReportPanelHealth();
  const reportRef = useRef(report);
  reportRef.current = report;

  const fetchAll = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const queries = Array.from(registry.current, ([id, { spec }]) => ({ id, ...spec }));
    if (queries.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await api.observabilityQueryBatch(range, queries, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const next = res.data?.results ?? {};
      setResults(next);
      setError(null);
      // A degraded slot means Prometheus was unreachable (e.g. a LEAN deploy).
      for (const { id } of queries) {
        const slot = next[id];
        reportRef.current(id, Boolean(slot?.ok && 'degraded' in slot.data && slot.data.degraded));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err as Error);
      // A hard error isn't a degraded-but-reachable result — clear every flag.
      for (const { id } of queries) reportRef.current(id, false);
    }
  }, [range]);

  const register = useCallback((id: string, spec: PanelQuerySpec) => {
    const map = registry.current;
    const existing = map.get(id);
    if (existing) {
      existing.refs += 1;
    } else {
      map.set(id, { spec, refs: 1 });
      setGeneration((g) => g + 1);
    }
    return () => {
      const reg = map.get(id);
      if (!reg) return;
      reg.refs -= 1;
      if (reg.refs > 0) return;
      map.delete(id);
      // Don't leave a removed panel holding the page-level "degraded" banner up.
      reportRef.current(id, false);
    };
  }, []);

  // A new range: every panel starts over from loading, and an in-flight read
  // for the old range can't land on top of it.
  useEffect(() => {
    abortRef.current?.abort();
    setResults({});
    setError(null);
  }, [range]);

  // A new query set or range: one fetch, deferred a tick so every panel
  // registering in the same commit lands in the same request.
  useEffect(() => {
    const timer = setTimeout(() => { void fetchAll(); }, 0);
    return () => clearTimeout(timer);
  }, [generation, fetchAll]);

  useEffect(() => () => abortRef.current?.abort(), []);

  usePolling(fetchAll, intervalMs, { immediate: false });

  const value = useMemo(() => ({ register, results, error }), [register, results, error]);
  return <DashboardQueriesContext.Provider value={value}>{children}</DashboardQueriesContext.Provider>;
}

/**
 * One panel's slice of its dashboard's batch: `{ data, loading, error }`, the
 * same shape a standalone fetch hook returns. Must render inside a
 * {@link DashboardQueryProvider}.
 */
export function useDashboardPanelQuery<T>(spec: PanelQuerySpec): { data: T | null; loading: boolean; error: Error | null } {
  const ctx = useContext(DashboardQueriesContext);
  if (!ctx) throw new Error('useDashboardPanelQuery must be used inside <DashboardQueryProvider>');
  const { register, results, error } = ctx;
  // Fixed key order, so equal specs (from any panel) map to the same slot.
  const id = JSON.stringify([spec.key, spec.audit ?? false, spec.limit, spec.event, spec.actor, spec.requestId]);
  const specRef = useRef(spec);
  specRef.current = spec;
  useEffect(() => register(id, specRef.current), [register, id]);

  const slot = results[id];
  return useMemo(() => {
    if (error) return { data: null, loading: false, error };
    if (!slot) return { data: null, loading: true, error: null };
    if (slot.ok) return { data: slot.data as T, loading: false, error: null };
    return { data: null, loading: false, error: new Error(slot.message) };
  }, [slot, error]);
}
