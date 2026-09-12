// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import { Gauge, Trophy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useFetch } from '@/hooks/useFetch';
import { doraLevelBadge, GRADE_STYLES } from '@/components/reports/ReportHelpers';
import type { TabDataStatus } from '../useReportData';
import api from '@/lib/api';
import type { ScorecardRollup, ScorecardLeaderboardEntry } from '@/types';

interface ScorecardTabProps {
  /** Whether `advanced_reporting` is entitled — non-entitled renders an upsell. */
  enabled: boolean;
  /** Report loading/error/refetch up to the shell (shared banner + refresh). */
  onStatus: (status: TabDataStatus) => void;
}

/** Compact DORA band pill (elite/high/…); dash when a dimension has no data. */
function Band({ level }: { level: ScorecardLeaderboardEntry['dora']['deploymentFrequency'] }) {
  const badge = doraLevelBadge(level);
  return badge ? <span className={badge.className}>{badge.label}</span> : <span className="text-gray-300 text-xs">—</span>;
}

/**
 * Org-wide maturity roll-up: a "software health" leaderboard ranking every
 * pipeline in the org by its blended compliance + DORA grade, plus aggregate
 * stats. Entitlement-gated on `advanced_reporting` (same as DORA / per-pipeline
 * scorecard). Server-computed over a fixed trailing-30-day window; bounded.
 */
export function ScorecardTab({ enabled, onStatus }: ScorecardTabProps) {
  const { data, loading, error, refetch } = useFetch<ScorecardRollup | null>(
    async () => {
      if (!enabled) return null;
      const res = await api.getOrgScorecardRollup();
      if (res.success && res.data) return res.data.rollup;
      throw new Error('Failed to load scorecard roll-up');
    },
    [enabled],
  );

  // TabDataStatus.error is a string; useFetch surfaces an Error — stringify it.
  const errorMessage = error ? (error.message || 'Failed to load') : null;
  useEffect(() => { onStatus({ loading, error: errorMessage, refetch }); }, [loading, errorMessage, refetch, onStatus]);

  if (!enabled) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Trophy className="w-5 h-5 text-gray-400" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Software-health leaderboard</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          The org-wide maturity roll-up requires the <span className="font-medium">advanced_reporting</span> feature.
        </p>
      </Card>
    );
  }

  if (loading && !data) return <Card><p className="text-sm text-gray-400">Computing org-wide scorecard…</p></Card>;
  if (error) return <Card><p className="text-sm text-red-500">Could not load the scorecard roll-up.</p></Card>;
  if (!data || data.pipelineCount === 0) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Trophy className="w-5 h-5 text-gray-400" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Software-health leaderboard</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">No pipelines to score yet. Create a pipeline and record deploys to build a leaderboard.</p>
      </Card>
    );
  }

  const grades = ['A', 'B', 'C', 'D', 'F', 'N/A'].filter((g) => (data.gradeDistribution[g] ?? 0) > 0);

  return (
    <div className="space-y-6">
      {/* Aggregate summary */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Gauge className="w-6 h-6 text-gray-400" />
            <div>
              <div className="text-3xl font-semibold text-gray-900 dark:text-gray-100">
                {data.averageScore ?? '—'}<span className="text-base text-gray-400 font-normal"> / 100 avg</span>
              </div>
              <div className="text-xs text-gray-400">
                {data.scored} of {data.pipelineCount} pipeline{data.pipelineCount === 1 ? '' : 's'} scored
                {data.truncated && ' · showing the first page (more exist)'}
                {/* "not scored" otherwise reads as "no data"; an error is a
                    different thing and the average is computed without them. */}
                {!!data.failed && (
                  <span className="text-amber-600 dark:text-amber-500">
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
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th scope="col" className="py-2 pr-3 font-medium">#</th>
              <th scope="col" className="py-2 pr-3 font-medium">Pipeline</th>
              <th scope="col" className="py-2 pr-3 font-medium">Grade</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Score</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Compliance</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Delivery</th>
              <th scope="col" className="py-2 pr-3 font-medium">Deploy freq</th>
              <th scope="col" className="py-2 pr-3 font-medium">Change fail</th>
              <th scope="col" className="py-2 pr-3 font-medium">Restore</th>
              <th scope="col" className="py-2 font-medium">Lead time</th>
            </tr>
          </thead>
          <tbody>
            {data.leaderboard.map((entry, i) => (
              <tr key={entry.pipelineId} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                <td className="py-2 pr-3 text-gray-400 tabular-nums">{i + 1}</td>
                <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{entry.name ?? entry.pipelineId}</td>
                <td className="py-2 pr-3">
                  <span className={`inline-flex items-center justify-center w-7 h-7 rounded-md text-xs font-bold ${GRADE_STYLES[entry.grade]}`}>{entry.grade}</span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-900 dark:text-gray-100">{entry.score ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-500">{entry.compliance.score ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-500">{entry.dora.score ?? '—'}</td>
                <td className="py-2 pr-3"><Band level={entry.dora.deploymentFrequency} /></td>
                <td className="py-2 pr-3"><Band level={entry.dora.changeFailureRate} /></td>
                <td className="py-2 pr-3"><Band level={entry.dora.meanTimeToRestore} /></td>
                <td className="py-2"><Band level={entry.dora.leadTime} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-[11px] text-gray-400">
        Scores blend compliance posture (rule dry-run) with DORA delivery bands over the trailing 30 days.
      </p>
    </div>
  );
}
