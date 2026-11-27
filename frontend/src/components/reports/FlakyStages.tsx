// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { fmtDate, ReportEmpty, SectionHeading, ExportCSVButton } from './ReportHelpers';
import { pipelineRunsHref } from './report-copy';
import type { FlakyStageRow, FlakyTrendPoint } from './types';

interface FlakyStagesProps {
  stages: FlakyStageRow[];
  /** The bucketed flake rate; only read (and shown) with Advanced Reporting. */
  trend: FlakyTrendPoint[];
  /** `advanced_reporting` is entitled — shows the trend instead of the add-on note. */
  trendEnabled: boolean;
}

/**
 * Pipelines → Failures: stages that FAILED and then PASSED on retry in the same
 * execution, ranked per (pipeline, stage) with the flake rate. A flake never
 * shows in the failure rates above — the run's final outcome was a success —
 * which is exactly why it needs its own list. The ranked list ships on every
 * tier; the flake rate over time is the Advanced Reporting half.
 */
export function FlakyStages({ stages, trend, trendEnabled }: FlakyStagesProps) {
  const max = Math.max(1, ...trend.map((p) => p.flake_pct));
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <SectionHeading>Flaky stages</SectionHeading>
        <ExportCSVButton
          data={stages.map((s) => ({
            pipeline: s.pipeline_name ?? s.pipeline_id, stage: s.stage_name, flaky_runs: s.flaky_runs,
            runs: s.runs, flake_pct: s.flake_pct, actions: s.flaky_actions.join(' '), last_flaked: s.last_flaked ?? '',
          }))}
          filename="flaky-stages"
        />
      </div>
      <p className="text-xs text-fg-subtle mb-3">Failed, then passed on retry, in the same run. These runs count as successes in the rates above.</p>
      {stages.length === 0 ? <ReportEmpty text="No flaky stages in this window" /> : (
        <ul className="space-y-2.5">
          {stages.map((s) => (
            <li key={`${s.pipeline_id}\u0000${s.stage_name}`}>
              <div className="flex justify-between text-sm mb-1 gap-2">
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="text-fg truncate">{s.stage_name}</span>
                  <Link href={pipelineRunsHref(s.pipeline_id)} className="text-xs text-fg-subtle hover:text-brand hover:underline truncate" title="Open this pipeline's runs">
                    {s.pipeline_name || s.pipeline_id}
                  </Link>
                  {s.flaky_actions.length > 0 && (
                    <span className="text-2xs text-fg-subtle font-mono truncate">{s.flaky_actions.join(', ')}</span>
                  )}
                </span>
                <span className="text-xs text-fg-subtle tabular-nums shrink-0">
                  {s.flaky_runs}/{s.runs} runs ({s.flake_pct}%){s.last_flaked ? <> &middot; {fmtDate(s.last_flaked)}</> : null}
                </span>
              </div>
              <div className="h-1 bg-surface-muted rounded-full overflow-hidden" aria-hidden="true">
                <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.min(s.flake_pct, 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-default pt-3">
        <h4 className="text-xs font-medium text-fg-muted mb-2">Flake rate over time</h4>
        {!trendEnabled ? (
          <p className="text-xs text-fg-subtle">
            The flake rate per period is part of Advanced Reporting.{' '}
            <Link href="/dashboard/usage?tab=billing&highlight=advanced_reporting" className="action-link">Unlock it</Link>
          </p>
        ) : trend.length === 0 ? <ReportEmpty text="No stage runs in this window" /> : (
          <>
            <div className="flex items-end gap-1 h-12" role="img" aria-label={`Flake rate over ${trend.length} period${trend.length === 1 ? '' : 's'}`}>
              {trend.map((p) => (
                <div key={p.period} className="flex-1 flex flex-col justify-end" title={`${fmtDate(p.period)}: ${p.flaky_runs}/${p.runs} flaky (${p.flake_pct}%)`}>
                  <div className="w-full rounded-sm bg-amber-500/70" style={{ height: `${Math.max((p.flake_pct / max) * 100, p.flaky_runs > 0 ? 8 : 2)}%` }} />
                </div>
              ))}
            </div>
            <table className="sr-only">
              <caption>Flaky stage runs per period</caption>
              <thead><tr><th scope="col">Period</th><th scope="col">Flaky runs</th><th scope="col">Stage runs</th><th scope="col">Flake rate</th></tr></thead>
              <tbody>
                {trend.map((p) => (
                  <tr key={p.period}><td>{fmtDate(p.period)}</td><td>{p.flaky_runs}</td><td>{p.runs}</td><td>{p.flake_pct}%</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Card>
  );
}
