// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DataSeries } from '@/types/observability';

/**
 * Shared chart helpers for the observability panels. Originally inlined
 * in both LinePanel and StackedBarPanel; extracted so a new chart kind
 * picks up the same series-prep behaviour without re-implementing the
 * group-label fallback or the color cycle.
 */

export const SERIES_COLORS = [
  '#2563eb', // blue
  '#16a34a', // green
  '#dc2626', // red
  '#ea580c', // orange
  '#7c3aed', // purple
  '#0891b2', // cyan
  '#ca8a04', // yellow
  '#be185d', // pink
];

export function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(v) < 1 && v !== 0) return v.toFixed(2);
  return v.toFixed(1);
}

export interface PreparedSeries {
  label: string;
  color: string;
  points: Array<{ x: number; y: number }>;
}

/**
 * Convert raw `DataSeries[]` into a prepared shape suited for plot rendering.
 * Picks the legend label from `groupBy` if specified, otherwise tries
 * `status`/`state`/first-label across ALL series (not just series[0]) so
 * disjoint-label sets still find a consistent grouping key.
 */
export function prepareSeries(series: DataSeries[], groupBy: string | undefined): PreparedSeries[] {
  const groupKey = groupBy ?? findCommonLabelKey(series);
  return series.map((s, i) => ({
    label: (groupKey && s.labels[groupKey]) || `series ${i + 1}`,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    points: s.values
      .map((p) => ({ x: p.time, y: parseFloat(p.value) }))
      .filter((p) => Number.isFinite(p.y)),
  }));
}

function findCommonLabelKey(series: DataSeries[]): string | undefined {
  for (const preferred of ['status', 'state']) {
    if (series.every((s) => s.labels[preferred] !== undefined)) return preferred;
  }
  // Fall back to the first label key present on every series.
  const candidates = Object.keys(series[0]?.labels ?? {});
  return candidates.find((k) => series.every((s) => s.labels[k] !== undefined));
}
