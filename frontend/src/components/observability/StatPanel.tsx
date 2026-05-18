// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useObservabilityQuery, type RangeKey } from '@/hooks/useObservabilityQuery';
import { Panel } from './Panel';

interface StatPanelProps {
  queryKey: string;
  title: string;
  range: RangeKey;
  span?: 3 | 4 | 6 | 8 | 9 | 12;
  format?: (v: number) => string;
}

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(v) < 1 && v !== 0) return v.toFixed(2);
  return v.toFixed(0);
}

/**
 * Single big number from a Prometheus instant query. v1 ships without a
 * delta-vs-previous-period readout — explicit non-goal in the plan.
 */
export function StatPanel({ queryKey, title, range, span = 3, format = defaultFormat }: StatPanelProps) {
  const { data, loading, error } = useObservabilityQuery(queryKey, range);
  // Sum across all samples — most stat queries are already aggregated, but
  // a sum-over-empty result tolerates either single-series or zero-series
  // returns.
  const samples = (data && 'samples' in data) ? data.samples : [];
  const sum = samples.reduce((acc, s) => acc + parseFloat(s.value), 0);
  const empty = !loading && !error && samples.length === 0;

  return (
    <Panel title={title} span={span} loading={loading} error={error} empty={empty}>
      <div className="text-center">
        <div className="text-3xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
          {format(sum)}
        </div>
      </div>
    </Panel>
  );
}
