// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Gauge } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import { doraLevelBadge, GRADE_STYLES } from '@/components/reports/DoraParts';
import { useReportBucketing } from '@/components/reports/useReportData';
import api from '@/lib/api';
import type { PipelineScorecard, PipelineScorecardHistory, ScorecardDoraLevel, ScorecardHistoryPoint } from '@/types';

/** Windows a grade-history strip asks for (the server cap). */
export const GRADE_HISTORY_PERIODS = 12;

/** One strip cell's accessible name: "2026-W47 (so far): grade A, score 82". */
function cellLabel(p: { label: string; partial: boolean; score: number | null; grade: string; unavailable?: boolean }): string {
  const when = p.partial ? `${p.label} (so far)` : p.label;
  if (p.unavailable) return `${when}: could not be computed`;
  if (p.score === null) return `${when}: not enough data`;
  return `${when}: grade ${p.grade}, score ${p.score}`;
}

/**
 * A row of small grade cells, oldest → newest, one per history window, coloured
 * with the same GRADE_STYLES as the badge. `compact` drops the letters (a
 * leaderboard row); the full strip prints them. A window that failed to compute
 * is a hollow gap, never an F; the current (partial) window is dashed.
 */
export function GradeHistoryStrip({ points, label, compact = false }: {
  points: ReadonlyArray<Pick<ScorecardHistoryPoint, 'label' | 'partial' | 'score' | 'grade' | 'unavailable'>>;
  /** The list's accessible name, e.g. "Grade history, last 12 weeks". */
  label: string;
  compact?: boolean;
}) {
  if (points.length === 0) return null;
  return (
    <ul aria-label={label} className="flex items-end gap-0.5">
      {points.map((p) => {
        const name = cellLabel(p);
        const tone = p.unavailable ? 'border border-dashed border-default bg-transparent' : GRADE_STYLES[p.grade] ?? GRADE_STYLES['N/A'];
        return (
          <li
            key={p.label}
            aria-label={name}
            title={name}
            className={`inline-flex items-center justify-center rounded-sm font-semibold leading-none ${compact ? 'w-2 h-4' : 'w-5 h-5 text-2xs'} ${tone} ${p.partial ? 'opacity-70 outline outline-1 outline-dashed outline-current' : ''}`}
          >
            {!compact && !p.unavailable && p.score !== null ? p.grade : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The card's history strip: its own read, silent on failure (the card still stands). */
function CardGradeHistory({ pipelineId }: { pipelineId: string }) {
  const bucketing = useReportBucketing();
  const { ready, tz, weekStart } = bucketing;
  const read = useFetch<PipelineScorecardHistory | null>(async (signal) => {
    const res = await api.getPipelineScorecardHistory(pipelineId, {
      interval: 'week', periods: GRADE_HISTORY_PERIODS, tz, ...(weekStart && { weekStart }),
    }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the grade history');
    return res.data.history;
  }, [pipelineId, ready, tz, weekStart], { enabled: ready });
  const points = read.data?.points ?? [];
  if (read.error || points.length === 0) return null;
  return (
    <div className="pt-2 border-t border-default">
      <div className="text-xs text-fg-subtle mb-1">Grade, last {points.length} week{points.length === 1 ? '' : 's'}</div>
      <GradeHistoryStrip points={points} label={`Grade history, last ${points.length} weeks`} />
    </div>
  );
}

/** The security dimension's row: open plugin exposures + artifact report findings. */
function SecurityRow({ security }: { security: PipelineScorecard['security'] | undefined }) {
  if (!security) return null;
  const { exposures, artifact } = security;
  const kev = exposures.kev + (artifact?.kev ?? 0);
  const parts = [
    `${exposures.count} open plugin exposure${exposures.count === 1 ? '' : 's'}`,
    artifact ? `${artifact.critical} crit · ${artifact.high} high in ${artifact.reports} artifact report${artifact.reports === 1 ? '' : 's'}` : 'no artifact reports',
  ];
  return (
    <div className="flex items-center justify-between gap-2 text-sm" data-testid="scorecard-security">
      <span className="text-fg-muted">Security</span>
      <span className="text-right text-xs text-fg-muted">
        {parts.join(' · ')}
        {kev > 0 && <span className="ml-1 font-medium text-danger-strong">· {kev} KEV</span>}
      </span>
    </div>
  );
}

/** One DORA band row. An `insufficient` level (sample under the minimum) is
 *  unscored and says "Not enough data (n = X)" rather than a rating. */
function Band({ label, level, n }: { label: string; level: ScorecardDoraLevel; n?: number }) {
  const badge = doraLevelBadge(level, n);
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-fg-muted">{label}</span>
      {badge ? <span className={badge.className}>{badge.label}</span> : <span className="text-fg-subtle text-xs">n/a</span>}
    </div>
  );
}

/**
 * Per-pipeline maturity scorecard card for the pipeline detail page. Blends
 * compliance posture + DORA bands into a graded score. Without the
 * `advanced_reporting` entitlement (the endpoint is gated on it too) the card
 * shows the in-place plan lock instead — never fetches, never 403s.
 */
export function ScorecardCard({ pipelineId }: { pipelineId: string }) {
  const gate = useFeatureGate('advanced_reporting');
  const enabled = gate.entitled;

  const read = useFetch<PipelineScorecard | null>(async (signal) => {
    const res = await api.getPipelineScorecard(pipelineId, { signal });
    // A `success: false` body is a failure too — not an empty scorecard.
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the scorecard');
    return res.data.scorecard;
  }, [pipelineId, enabled], { enabled });
  const scorecard = read.data;
  const loading = enabled && read.loading;
  const failed = !!read.error;

  if (!enabled) {
    // Nothing until the entitlement has resolved (no flash of the lock), then
    // the lock names what's missing and where to get it.
    if (!gate.isLoaded) return null;
    return (
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Gauge className="w-5 h-5 text-fg-muted" aria-hidden="true" />
          <h3 className="text-base font-semibold text-fg">Maturity scorecard</h3>
        </div>
        <FeatureLock flag="advanced_reporting" />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Gauge className="w-5 h-5 text-fg-muted" />
        <h3 className="text-base font-semibold text-fg">Maturity scorecard</h3>
      </div>
      {loading ? (
        <p className="text-sm text-fg-subtle">Computing…</p>
      ) : failed || !scorecard || scorecard.unavailable ? (
        // `scorecard.unavailable` belongs HERE, ahead of the empty state: the
        // server sets it when the card could not be computed, and that arrives
        // looking exactly like "no data yet" (null score, N/A grade). Falling
        // through told the reader to go enable DORA events in answer to a
        // server-side error.
        <p className="text-sm text-fg-subtle">Scorecard unavailable.</p>
      ) : scorecard.grade === 'N/A' && scorecard.score == null ? (
        // Empty state: no compliance rules evaluated AND no DORA data yet, so a
        // grade can't be computed. Show what unlocks it instead of a wall of
        // N/A rows (which read as broken on a fresh pipeline).
        <div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center justify-center w-12 h-12 rounded-lg text-base font-bold ${GRADE_STYLES['N/A']}`}>
              N/A
            </span>
            <div>
              <div className="text-sm font-medium text-fg-muted">Not enough data yet</div>
              <div className="text-xs text-fg-subtle">A grade appears once this pipeline has enforced compliance rules, recorded production deploys, or a security signal.</div>
            </div>
          </div>
          <p className="text-2xs text-fg-subtle mt-3">
            DORA metrics need deploy events (enable with <code className="font-mono">setup-events --with-dora</code> and deploy to production); the compliance score needs enforced rules.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center justify-center w-12 h-12 rounded-lg text-xl font-bold ${GRADE_STYLES[scorecard.grade]}`}>
              {scorecard.grade}
            </span>
            <div>
              <div className="text-2xl font-semibold text-fg">
                {scorecard.score ?? '—'}<span className="text-sm text-fg-subtle font-normal"> / 100</span>
              </div>
              <div className="text-xs text-fg-subtle">
                compliance {scorecard.compliance.score ?? '—'} · delivery {scorecard.dora.score ?? '—'} · security {scorecard.security?.score ?? '—'}
              </div>
            </div>
          </div>
          <CardGradeHistory pipelineId={pipelineId} />
          <div className="pt-2 border-t border-default space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-fg-muted">Compliance</span>
              <span className="text-xs text-fg-muted">
                {scorecard.compliance.rulesEvaluated} rules · {scorecard.compliance.violations} viol · {scorecard.compliance.warnings} warn
              </span>
            </div>
            <Band label="Deploy frequency" level={scorecard.dora.deploymentFrequency} n={scorecard.dora.samples?.deploymentFrequency} />
            <Band label="Change failure rate" level={scorecard.dora.changeFailureRate} n={scorecard.dora.samples?.changeFailureRate} />
            <Band label="Median time to restore" level={scorecard.dora.meanTimeToRestore} n={scorecard.dora.samples?.meanTimeToRestore} />
            <Band label="Lead time" level={scorecard.dora.leadTime} n={scorecard.dora.samples?.leadTime} />
            <SecurityRow security={scorecard.security} />
          </div>
          <p className="text-2xs text-fg-subtle">
            DORA basis: deploy-stage. Lead time is measured (commit → deploy); shown for the production environment. A band needs at least five deploys or measurements — below that it says “Not enough data” and is left out of the score.
            Security counts open plugin exposures and the latest artifact scans; it is unscored until either exists.
            Each history cell re-scores that week with the same formula (today&apos;s compliance and security, that week&apos;s deploys).
          </p>
        </div>
      )}
    </Card>
  );
}
