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
}

const CHART_WIDTH = 480;
const CHART_HEIGHT = 160;
const PAD = { top: 8, right: 8, bottom: 18, left: 32 };

export function LinePanel({ queryKey, title, range, span = 6, groupBy, format = defaultFormat }: LinePanelProps) {
  const { data, loading, error } = useObservabilityQuery(queryKey, range);

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
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        width="100%"
        className="block"
        role="img"
        aria-label={`${title}: ${prepared.length} series — ${prepared.map((s) => s.label).join(', ')}. Values ${format(yMin)} to ${format(yMax)}. The table below carries the same data.`}
      >
        {/* Y axis ticks (3 horizontal grid lines) */}
        {[0, 0.5, 1].map((t) => {
          const y = PAD.top + plotH * (1 - t);
          const v = yMin + ySpan * t;
          return (
            <g key={t}>
              <line x1={PAD.left} y1={y} x2={CHART_WIDTH - PAD.right} y2={y} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth="0.5" />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" className="fill-current text-fg-muted" fontSize="9">{format(v)}</text>
            </g>
          );
        })}
        {/* Series polylines — colour AND dash, so series stay distinguishable
            without colour vision. */}
        {prepared.map((s) => (
          <polyline
            key={s.label}
            points={s.points.map((p) => `${xFor(p.x)},${yFor(p.y)}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeDasharray={s.dash || undefined}
            strokeWidth="1.5"
          />
        ))}
      </svg>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2 text-xs text-fg-muted">
        {prepared.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            {/* Legend swatch mirrors the line's dash, not just its colour. */}
            <svg width="12" height="2" aria-hidden="true" className="block">
              <line x1="0" y1="1" x2="12" y2="1" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash || undefined} />
            </svg>
            {s.label}
          </span>
        ))}
      </div>

      {/* Same data as a table for screen readers — an SVG polyline is opaque to
          them. Latest value per series (the number people read off a trend). */}
      <table className="sr-only">
        <caption>{title} — latest value per series</caption>
        <thead>
          <tr><th scope="col">Series</th><th scope="col">Latest value</th></tr>
        </thead>
        <tbody>
          {prepared.map((s) => (
            <tr key={s.label}>
              <td>{s.label}</td>
              <td>{s.points.length > 0 ? format(s.points[s.points.length - 1].y) : 'no data'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
