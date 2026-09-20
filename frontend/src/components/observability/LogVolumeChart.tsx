// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import type { LogVolumeResponse } from '@/types/logs';
import { normalizeLevel, type LogLevel } from '@/types/logs';

/**
 * Log-volume histogram: one stacked bar per time bucket, split by level.
 *
 * Stacked by level rather than a single-colour total on purpose — `level` is
 * already a promoted Loki label, so the error/warn banding is free, and a red
 * band is the thing an operator is actually scanning the chart for.
 *
 * Bars are plain divs rather than a chart library: the geometry is a 1-D bar
 * run, and the surrounding pages already avoid pulling a charting dependency
 * for this shape.
 */

const LEVEL_ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug'];

const LEVEL_CLASS: Record<LogLevel, string> = {
  error: 'bg-red-500 dark:bg-red-500',
  warn: 'bg-amber-500 dark:bg-amber-400',
  info: 'bg-emerald-500 dark:bg-emerald-400',
  debug: 'bg-gray-400 dark:bg-gray-500',
};

interface Bucket {
  time: number;
  counts: Record<LogLevel, number>;
  total: number;
}

interface LogVolumeChartProps {
  data?: LogVolumeResponse;
  loading?: boolean;
  /** Click a bar to zoom the window to that bucket. */
  onSelectBucket?: (fromMs: number, toMs: number) => void;
}

export function LogVolumeChart({ data, loading, onSelectBucket }: LogVolumeChartProps) {
  const { buckets, peak, stepMs } = useMemo(() => {
    const byTime = new Map<number, Bucket>();
    for (const series of data?.series ?? []) {
      const level = normalizeLevel(series.labels.level) ?? 'info';
      for (const { time, value } of series.values) {
        const n = Number(value);
        if (!Number.isFinite(n) || n === 0) continue;
        const bucket = byTime.get(time)
          ?? { time, counts: { error: 0, warn: 0, info: 0, debug: 0 }, total: 0 };
        bucket.counts[level] += n;
        bucket.total += n;
        byTime.set(time, bucket);
      }
    }
    const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
    // `step` is a Loki duration ('30s'); used to size a bar's click target.
    const seconds = parseInt(data?.step ?? '60', 10);
    return {
      buckets: sorted,
      peak: sorted.reduce((m, b) => Math.max(m, b.total), 0),
      stepMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
    };
  }, [data]);

  const total = buckets.reduce((sum, b) => sum + b.total, 0);

  if (loading && buckets.length === 0) {
    return <div className="h-24 animate-pulse rounded bg-gray-100 dark:bg-gray-800" aria-hidden />;
  }
  if (buckets.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded border border-dashed border-gray-200 text-xs text-fg-muted dark:border-gray-700">
        No log volume in this window
      </div>
    );
  }

  const first = buckets[0].time * 1000;
  const last = buckets[buckets.length - 1].time * 1000;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs text-fg-muted">
        <span><span className="font-medium text-gray-700 dark:text-gray-200">{total.toLocaleString()}</span> lines</span>
        <div className="flex items-center gap-3">
          {LEVEL_ORDER.map((level) => (
            <span key={level} className="flex items-center gap-1">
              <span className={`inline-block h-2 w-2 rounded-sm ${LEVEL_CLASS[level]}`} aria-hidden />
              {level}
            </span>
          ))}
        </div>
      </div>

      <div className="flex h-24 items-end gap-px" role="img" aria-label={`Log volume, ${total} lines across ${buckets.length} buckets`}>
        {buckets.map((bucket) => {
          const heightPct = peak > 0 ? (bucket.total / peak) * 100 : 0;
          const label = `${new Date(bucket.time * 1000).toLocaleString([], { hour12: false })} — ${bucket.total} lines`;
          const Wrapper = onSelectBucket ? 'button' : 'div';
          return (
            <Wrapper
              key={bucket.time}
              // `flex-1 min-w-0` lets the run fill the width at any bucket count
              // without overflowing on narrow screens.
              className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
              title={label}
              {...(onSelectBucket
                ? {
                  type: 'button' as const,
                  onClick: () => onSelectBucket(bucket.time * 1000, bucket.time * 1000 + stepMs),
                  'aria-label': `Zoom to ${label}`,
                }
                : {})}
            >
              <div className="w-full opacity-90 transition-opacity group-hover:opacity-100" style={{ height: `${heightPct}%` }}>
                {LEVEL_ORDER.map((level) => {
                  const count = bucket.counts[level];
                  if (count === 0) return null;
                  return (
                    <div
                      key={level}
                      className={LEVEL_CLASS[level]}
                      style={{ height: `${(count / bucket.total) * 100}%` }}
                    />
                  );
                })}
              </div>
            </Wrapper>
          );
        })}
      </div>

      <div className="mt-1 flex justify-between text-2xs text-fg-subtle">
        <span>{new Date(first).toLocaleTimeString([], { hour12: false })}</span>
        <span>{new Date(last).toLocaleTimeString([], { hour12: false })}</span>
      </div>
    </div>
  );
}
