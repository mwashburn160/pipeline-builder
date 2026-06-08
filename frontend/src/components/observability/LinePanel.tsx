// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useObservabilityQuery } from '@/hooks/useObservabilityQuery';
import type { RangeKey } from '@/types/observability';
import { Panel } from './Panel';
import { defaultFormat, prepareSeries } from './_chartUtils';

interface LinePanelProps {
  queryKey: string;
  title: string;
  range: RangeKey;
  /** Tailwind col-span (1-12). */
  span?: 3 | 4 | 6 | 8 | 9 | 12;
  /** Label-set field used to color/legend series (e.g. 'status' or 'state'). */
  groupBy?: string;
  /** Y-axis value formatter — e.g. percent, seconds, bytes. */
  format?: (v: number) => string;
  /** Optional template variables (e.g. plugin name for the per-plugin drill-down). */
  vars?: { plugin?: string };
}

const CHART_WIDTH = 480;
const CHART_HEIGHT = 160;
const PAD = { top: 8, right: 8, bottom: 18, left: 32 };

export function LinePanel({ queryKey, title, range, span = 6, groupBy, format = defaultFormat, vars }: LinePanelProps) {
  const { data, loading, error } = useObservabilityQuery(queryKey, range, vars);

  const series = (data && 'series' in data) ? data.series : [];
  const prepared = prepareSeries(series, groupBy);
  const allPoints = prepared.flatMap((s) => s.points);
  const empty = !loading && !error && allPoints.length === 0;

  if (empty || loading || error) {
    return <Panel title={title} span={span} loading={loading} error={error} empty={empty}>{null}</Panel>;
  }

  // `prepareSeries` already filters non-finite ys, so `allPoints` is safe
  // to min/max directly. If every point was NaN the empty-state branch
  // above already returned.
  const xMin = Math.min(...allPoints.map((p) => p.x));
  const xMax = Math.max(...allPoints.map((p) => p.x));
  const yValues = allPoints.map((p) => p.y);
  const yMin = Math.min(0, ...yValues);
  const yMax = Math.max(...yValues);
  const ySpan = yMax === yMin ? 1 : yMax - yMin;
  const xSpan = xMax === xMin ? 1 : xMax - xMin;
  const plotW = CHART_WIDTH - PAD.left - PAD.right;
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;

  const xFor = (x: number) => PAD.left + ((x - xMin) / xSpan) * plotW;
  const yFor = (y: number) => PAD.top + plotH - ((y - yMin) / ySpan) * plotH;

  return (
    <Panel title={title} span={span} loading={false} error={null} empty={false}>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} width="100%" className="block">
        {/* Y axis ticks (3 horizontal grid lines) */}
        {[0, 0.5, 1].map((t) => {
          const y = PAD.top + plotH * (1 - t);
          const v = yMin + ySpan * t;
          return (
            <g key={t}>
              <line x1={PAD.left} y1={y} x2={CHART_WIDTH - PAD.right} y2={y} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth="0.5" />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" className="fill-current text-gray-500 dark:text-gray-400" fontSize="9">{format(v)}</text>
            </g>
          );
        })}
        {/* Series polylines */}
        {prepared.map((s) => (
          <polyline
            key={s.label}
            points={s.points.map((p) => `${xFor(p.x)},${yFor(p.y)}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth="1.5"
          />
        ))}
      </svg>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-600 dark:text-gray-400">
        {prepared.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </Panel>
  );
}
