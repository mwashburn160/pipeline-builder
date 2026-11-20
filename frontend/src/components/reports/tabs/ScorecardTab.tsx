// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type FormEvent } from 'react';
import { Gauge, Trophy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useFetch } from '@/hooks/useFetch';
import { doraLevelBadge, GRADE_STYLES } from '@/components/reports/DoraParts';
import type { TabDataStatus } from '../useReportData';
import api from '@/lib/api';
import type { ScorecardRollup, ScorecardLeaderboardEntry, ScorecardRollupQuery } from '@/types';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FilterInput } from '@/components/ui/FilterInput';

interface ScorecardTabProps {
  /** Whether `advanced_reporting` is entitled — non-entitled renders an upsell. */
  enabled: boolean;
  /** Report loading/error/refetch up to the shell (shared banner + refresh). */
  onStatus: (status: TabDataStatus) => void;
}

/** Compact DORA band pill (elite/high/…); "Not enough data (n = X)" below the
 *  minimum sample (unscored, never "low"); dash when a dimension has no data. */
function Band({ level, n }: { level: ScorecardLeaderboardEntry['dora']['deploymentFrequency']; n?: number }) {
  const badge = doraLevelBadge(level, n);
  return badge ? <span className={badge.className}>{badge.label}</span> : <span className="text-fg-subtle text-xs">—</span>;
}

/**
 * Org-wide maturity roll-up: a "software health" leaderboard ranking every
 * pipeline in the org by its blended compliance + DORA grade, plus aggregate
 * stats. Entitlement-gated on `advanced_reporting` (same as DORA / per-pipeline
 * scorecard). Server-computed over a fixed trailing-30-day window; bounded.
 */
export function ScorecardTab({ enabled, onStatus }: ScorecardTabProps) {
  // The roll-up grades ONE page of the org's own pipelines (server cap 50), so
  // the page offset and the project / name narrowing are part of the read.
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<{ project: string; pipelineName: string }>({ project: '', pipelineName: '' });
  const [draft, setDraft] = useState(filter);
  const query: ScorecardRollupQuery = {
    offset,
    ...(filter.project && { project: filter.project }),
    ...(filter.pipelineName && { pipelineName: filter.pipelineName }),
  };
  const { data, loading, error, refetch } = useFetch<ScorecardRollup | null>(
    async () => {
      const res = await api.getOrgScorecardRollup(query);
      if (res.success && res.data) return res.data.rollup;
      throw new Error('Failed to load scorecard roll-up');
    },
    [enabled, offset, filter.project, filter.pipelineName],
    { enabled, keepPreviousData: true },
  );
  const filtered = !!(filter.project || filter.pipelineName);
  const applyFilter = (e: FormEvent) => {
    e.preventDefault();
    const next = { project: draft.project.trim(), pipelineName: draft.pipelineName.trim() };
    setFilter(next);
    setOffset(0);
  };

  // TabDataStatus.error is a string; useFetch surfaces an Error — stringify it.
  const errorMessage = error ? (error.message || 'Failed to load') : null;
  useEffect(() => { onStatus({ loading, error: errorMessage, refetch }); }, [loading, errorMessage, refetch, onStatus]);

  if (!enabled) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Trophy className="w-5 h-5 text-fg-subtle" />
          <h3 className="h3">Software-health leaderboard</h3>
        </div>
        <p className="text-sm text-fg-muted">
          The org-wide maturity roll-up requires the <span className="font-medium">advanced_reporting</span> feature.
        </p>
      </Card>
    );
  }

  const filterBar = (
    <form onSubmit={applyFilter} className="flex flex-wrap items-end gap-2" aria-label="Filter the leaderboard">
      <label className="text-xs text-fg-subtle flex flex-col gap-1">
        Project
        <FilterInput value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} placeholder="Any project" />
      </label>
      <label className="text-xs text-fg-subtle flex flex-col gap-1">
        Pipeline name
        <FilterInput value={draft.pipelineName} onChange={(e) => setDraft({ ...draft, pipelineName: e.target.value })} placeholder="Any name" />
      </label>
      <Button type="submit" size="sm" variant="secondary">Apply</Button>
      {filtered && (
        <Button size="sm" variant="ghost" onClick={() => { const cleared = { project: '', pipelineName: '' }; setDraft(cleared); setFilter(cleared); setOffset(0); }}>
          Clear
        </Button>
      )}
    </form>
  );

  if (loading && !data) return <Card><p className="text-sm text-fg-subtle">Computing org-wide scorecard…</p></Card>;
  if (error) return <Card><ErrorAlert message="Could not load the scorecard roll-up." onRetry={refetch} /></Card>;
  if (!data || data.pipelineCount === 0) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Trophy className="w-5 h-5 text-fg-subtle" />
          <h3 className="h3">Software-health leaderboard</h3>
        </div>
        {filtered && <div className="mb-3">{filterBar}</div>}
        {filtered
          ? <EmptyState compact title="No pipelines match" description="No pipeline in this organization matches that project / name." />
          : <EmptyState compact title="No pipelines to score yet" description="Create a pipeline and record deploys to build a leaderboard." />}
      </Card>
    );
  }

  const grades = ['A', 'B', 'C', 'D', 'F', 'N/A'].filter((g) => (data.gradeDistribution[g] ?? 0) > 0);
  const page = data.pagination;
  const paged = page.offset > 0 || page.hasMore;
  const first = page.offset + 1;
  const last = page.offset + data.pipelineCount;

  return (
    <div className="space-y-6">
      {filterBar}
      {/* Aggregate summary */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Gauge className="w-6 h-6 text-fg-subtle" />
            <div>
              <div className="text-3xl font-semibold text-fg">
                {data.averageScore ?? '—'}<span className="text-base text-fg-subtle font-normal"> / 100 avg</span>
              </div>
              <div className="text-xs text-fg-subtle">
                {data.scored} of {data.pipelineCount} pipeline{data.pipelineCount === 1 ? '' : 's'} scored
                {paged && ` · stats cover this page (pipelines ${first}–${last}${typeof page.total === 'number' ? ` of ${page.total}` : ''})`}
                {/* "not scored" otherwise reads as "no data"; an error is a
                    different thing and the average is computed without them. */}
                {!!data.failed && (
                  <span className="text-warning">
                    {' · '}{data.failed} could not be scored
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {grades.map((g) => (
              <span key={g} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold ${GRADE_STYLES[g]}`}>
                {g} <span className="font-normal opacity-80">×{data.gradeDistribution[g]}</span>
              </span>
            ))}
          </div>
        </div>
      </Card>

      {/* Ranked leaderboard */}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-fg-subtle border-b border-default">
              <th scope="col" className="py-2 pr-3 font-medium">#</th>
              <th scope="col" className="py-2 pr-3 font-medium">Pipeline</th>
              <th scope="col" className="py-2 pr-3 font-medium">Grade</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Score</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Compliance</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Delivery</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Security</th>
              <th scope="col" className="py-2 pr-3 font-medium">Deploy freq</th>
              <th scope="col" className="py-2 pr-3 font-medium">Change fail</th>
              <th scope="col" className="py-2 pr-3 font-medium">Median restore</th>
              <th scope="col" className="py-2 font-medium">Lead time</th>
            </tr>
          </thead>
          <tbody>
            {data.leaderboard.map((entry, i) => (
              <tr key={entry.pipelineId} className="border-b border-default last:border-0">
                <td className="py-2 pr-3 text-fg-subtle tabular-nums">{i + 1}</td>
                <td className="py-2 pr-3 font-medium text-fg">{entry.name ?? entry.pipelineId}</td>
                <td className="py-2 pr-3">
                  <span className={`inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold ${GRADE_STYLES[entry.grade]}`}>{entry.grade}</span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-fg">{entry.score ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">{entry.compliance.score ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">{entry.dora.score ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-fg-muted" title={entry.security ? `${entry.security.exposures.count} open plugin exposures${entry.security.artifact ? `, ${entry.security.artifact.reports} artifact reports` : ''}` : undefined}>
                  {entry.security?.score ?? '—'}
                  {(entry.security?.exposures.kev ?? 0) + (entry.security?.artifact?.kev ?? 0) > 0 && <span className="ml-1 text-2xs font-semibold text-danger-strong">KEV</span>}
                </td>
                <td className="py-2 pr-3"><Band level={entry.dora.deploymentFrequency} n={entry.dora.samples?.deploymentFrequency} /></td>
                <td className="py-2 pr-3"><Band level={entry.dora.changeFailureRate} n={entry.dora.samples?.changeFailureRate} /></td>
                <td className="py-2 pr-3"><Band level={entry.dora.meanTimeToRestore} n={entry.dora.samples?.meanTimeToRestore} /></td>
                <td className="py-2"><Band level={entry.dora.leadTime} n={entry.dora.samples?.leadTime} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {paged && (
        <nav className="flex items-center justify-between gap-2" aria-label="Leaderboard pages">
          <Button size="sm" variant="secondary" disabled={page.offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>
            Previous
          </Button>
          <span className="text-xs text-fg-subtle">Ranked within this page · newest-changed pipelines first</span>
          <Button size="sm" variant="secondary" disabled={page.nextOffset === null || loading}
            onClick={() => { if (page.nextOffset !== null) setOffset(page.nextOffset); }}>
            Next
          </Button>
        </nav>
      )}
      <p className="text-2xs text-fg-subtle">
        Scores blend compliance posture (rule dry-run), DORA delivery bands over the trailing 30 days and security (open plugin exposures + artifact scan findings; 40/40/20 when all three have data).
      </p>
    </div>
  );
}
