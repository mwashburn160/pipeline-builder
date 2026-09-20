// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BuildHealth } from '@/lib/api/domains/reporting';
import { ReportEmpty, SectionHeading, SectionCardSkeleton } from './ReportHelpers';
import { Card } from '@/components/ui/Card';
import { formatDuration } from '@/lib/format';

interface BuildHealthPanelProps {
  loading: boolean;
  buildHealth: BuildHealth | null;
  /** Whether a single pipeline is scoped (build health is per-pipeline). */
  pipelineSelected: boolean;
}

/** Success-rate pill color band: green ≥90%, amber ≥70%, red below. */
function rateClass(pct: number): string {
  if (pct >= 90) return 'bg-success-bg text-success';
  if (pct >= 70) return 'bg-warning-bg text-warning';
  return 'bg-danger-bg text-danger';
}

/**
 * Build Health — a standard (every-tier) per-pipeline stage breakdown rendered
 * NEXT TO the DORA panel. For the scoped pipeline it shows each stage's run count,
 * per-stage success rate, and duration percentiles (p50/p90/p99), plus totals.
 * Keyed by the DORA pipeline scope; shows a hint to pick a pipeline when none is
 * scoped. Theme-aware, reuses the shared Card + report helpers.
 */
export function BuildHealthPanel({ loading, buildHealth, pipelineSelected }: BuildHealthPanelProps) {
  if (loading && buildHealth === null) return <SectionCardSkeleton lines={5} />;

  return (
    <Card className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <SectionHeading>Build health</SectionHeading>
        {buildHealth && buildHealth.totals.runs > 0 && (
          <span className="text-xs text-fg-subtle tabular-nums">
            {buildHealth.totals.runs} stage {buildHealth.totals.runs === 1 ? 'run' : 'runs'} &middot; {buildHealth.totals.failureRate}% failed
          </span>
        )}
      </div>
      {!pipelineSelected ? (
        <ReportEmpty text="Select a pipeline to see its per-stage build health (success rate + timing percentiles)." />
      ) : !buildHealth || buildHealth.stages.length === 0 ? (
        <ReportEmpty text="No stage activity for this pipeline in the window." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-subtle border-b border-default">
                <th scope="col" className="py-2 pr-3 font-medium">Stage</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">Runs</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">Success</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">p50</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">p90</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">p99</th>
              </tr>
            </thead>
            <tbody>
              {buildHealth.stages.map((s) => (
                <tr key={s.stage} className="border-b border-default last:border-0">
                  <td className="py-2 pr-3 font-medium text-fg truncate max-w-[14rem]" title={s.stage}>{s.stage}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">
                    {s.runs}
                    {s.failures > 0 && (
                      <span className="text-danger"> ({s.failures} failed)</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium tabular-nums ${rateClass(s.successRate)}`}>
                      {s.successRate}%
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">{s.p50Ms == null ? '—' : formatDuration(s.p50Ms)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">{s.p90Ms == null ? '—' : formatDuration(s.p90Ms)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">{s.p99Ms == null ? '—' : formatDuration(s.p99Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
