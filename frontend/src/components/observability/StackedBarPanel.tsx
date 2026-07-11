// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useObservabilityLogs } from '@/hooks/useObservabilityLogs';
import type { RangeKey } from '@/types/observability';
import type { DataSeries } from '@/types/observability';
import { Panel } from './Panel';
import { SERIES_COLORS } from './_chartUtils';

interface StackedBarPanelProps {
  queryKey: string;
  title: string;
  range: RangeKey;
  span?: 3 | 4 | 6 | 8 | 9 | 12;
  /** Label-set key used to color/stack series (default: 'event'). */
  groupBy?: string;
}

const CHART_WIDTH = 480;
const CHART_HEIGHT = 160;
const PAD = { top: 8, right: 8, bottom: 18, left: 32 };

/**
 * Stacked-bar viz over a Loki matrix query. Each bar = one time bucket;
 * each color = one series (e.g. event name). Used for "audit events per
 * hour" where it's helpful to see the mix of event types over time.
 */
export function StackedBarPanel({ queryKey, title, range, span = 12, groupBy = 'event' }: StackedBarPanelProps) {
  const { data, loading, error } = useObservabilityLogs(queryKey, range);
  const series: DataSeries[] = (data && 'series' in data) ? data.series : [];
  const empty = !loading && !error && series.length === 0;

  if (empty || loading || error) {
    return <Panel title={title} span={span} loading={loading} error={error} empty={empty}>{null}</Panel>;
  }

  // Collect all unique timestamps, then sum each series at each timestamp.
  const timesSet = new Set<number>();
  for (const s of series) for (const p of s.values) timesSet.add(p.time);
  const times = [...timesSet].sort((a, b) => a - b);
  const seriesByTime: Map<number, Array<{ label: string; color: string; value: number }>> = new Map();
  for (const t of times) seriesByTime.set(t, []);
  series.forEach((s, i) => {
    const label = s.labels[groupBy] ?? `series ${i + 1}`;
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    const map = new Map(s.values.map((p) => [p.time, parseFloat(p.value)]));
    for (const t of times) {
      const v = map.get(t) ?? 0;
      if (v > 0) seriesByTime.get(t)!.push({ label, color, value: v });
    }
  });

  // Compute max stacked height for y-axis.
  let maxStacked = 0;
  for (const stack of seriesByTime.values()) {
    const sum = stack.reduce((a, b) => a + b.value, 0);
    if (sum > maxStacked) maxStacked = sum;
  }
  if (maxStacked === 0) maxStacked = 1;

  const plotW = CHART_WIDTH - PAD.left - PAD.right;
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const barW = times.length > 0 ? Math.max(2, plotW / times.length - 1) : 0;

  return (
    <Panel title={title} span={span} loading={false} error={null} empty={false}>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} width="100%" className="block">
        {[0, 0.5, 1].map((t) => {
          const y = PAD.top + plotH * (1 - t);
          const v = maxStacked * t;
          return (
            <g key={t}>
              <line x1={PAD.left} y1={y} x2={CHART_WIDTH - PAD.right} y2={y} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth="0.5" />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" className="fill-current text-gray-500 dark:text-gray-400" fontSize="9">{v.toFixed(0)}</text>
            </g>
          );
        })}
        {times.map((t, i) => {
          const stack = seriesByTime.get(t) ?? [];
          let yCursor = PAD.top + plotH;
          return (
            <g key={t}>
              {stack.map((seg, j) => {
                const h = (seg.value / maxStacked) * plotH;
                const y = yCursor - h;
                yCursor = y;
                return (
                  <rect
                    key={j}
                    x={PAD.left + (i * plotW) / times.length}
                    y={y}
                    width={barW}
                    height={h}
                    fill={seg.color}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      {/* Legend (deduped across all series — bar colors map per-series index). */}
      <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-600 dark:text-gray-400">
        {series.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {s.labels[groupBy] ?? `series ${i + 1}`}
          </span>
        ))}
      </div>
    </Panel>
  );
}
