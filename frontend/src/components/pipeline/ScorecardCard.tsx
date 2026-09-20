// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Gauge } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import { doraLevelBadge, GRADE_STYLES } from '@/components/reports/DoraParts';
import api from '@/lib/api';
import type { PipelineScorecard, ScorecardDoraLevel } from '@/types';

function Band({ label, level }: { label: string; level: ScorecardDoraLevel }) {
  const badge = doraLevelBadge(level);
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
    if (!enabled) return null;
    const res = await api.getPipelineScorecard(pipelineId, { signal });
    // A `success: false` body is a failure too — not an empty scorecard.
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the scorecard');
    return res.data.scorecard;
  }, [pipelineId, enabled]);
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
      ) : failed || !scorecard ? (
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
              <div className="text-xs text-fg-subtle">A grade appears once this pipeline has enforced compliance rules and recorded production deploys.</div>
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
                compliance {scorecard.compliance.score ?? '—'} · delivery {scorecard.dora.score ?? '—'}
              </div>
            </div>
          </div>
          <div className="pt-2 border-t border-default space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-fg-muted">Compliance</span>
              <span className="text-xs text-fg-muted">
                {scorecard.compliance.rulesEvaluated} rules · {scorecard.compliance.violations} viol · {scorecard.compliance.warnings} warn
              </span>
            </div>
            <Band label="Deploy frequency" level={scorecard.dora.deploymentFrequency} />
            <Band label="Change failure rate" level={scorecard.dora.changeFailureRate} />
            <Band label="Time to restore" level={scorecard.dora.meanTimeToRestore} />
            <Band label="Lead time" level={scorecard.dora.leadTime} />
          </div>
          <p className="text-2xs text-fg-subtle">DORA basis: deploy-stage. Lead time is measured (commit → deploy); shown for the production environment.</p>
        </div>
      )}
    </Card>
  );
}
