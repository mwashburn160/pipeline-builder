// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useFeatures } from '@/hooks/useFeatures';
import { doraLevelBadge } from '@/components/reports/ReportHelpers';
import api from '@/lib/api';
import type { PipelineScorecard, ScorecardDoraLevel } from '@/types';

const GRADE_STYLES: Record<string, string> = {
  A: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  B: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  C: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  F: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  'N/A': 'bg-gray-100 text-gray-600 dark:bg-gray-700/40 dark:text-gray-300',
};

function Band({ label, level }: { label: string; level: ScorecardDoraLevel }) {
  const badge = doraLevelBadge(level);
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      {badge ? <span className={badge.className}>{badge.label}</span> : <span className="text-gray-400 text-xs">n/a</span>}
    </div>
  );
}

/**
 * Per-pipeline maturity scorecard card for the pipeline detail page. Blends
 * compliance posture + DORA bands into a graded score. Renders nothing when the
 * `advanced_reporting` feature is off (the endpoint is gated on it too).
 */
export function ScorecardCard({ pipelineId }: { pipelineId: string }) {
  const features = useFeatures();
  const enabled = features.isEnabled('advanced_reporting');

  const [scorecard, setScorecard] = useState<PipelineScorecard | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api.getPipelineScorecard(pipelineId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) setScorecard(res.data.scorecard);
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pipelineId, enabled]);

  if (!enabled) return null;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Gauge className="w-5 h-5 text-gray-500" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Maturity scorecard</h3>
      </div>
      {loading ? (
        <p className="text-sm text-gray-400">Computing…</p>
      ) : failed || !scorecard ? (
        <p className="text-sm text-gray-400">Scorecard unavailable.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center justify-center w-12 h-12 rounded-lg text-xl font-bold ${GRADE_STYLES[scorecard.grade]}`}>
              {scorecard.grade}
            </span>
            <div>
              <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {scorecard.score ?? '—'}<span className="text-sm text-gray-400 font-normal"> / 100</span>
              </div>
              <div className="text-xs text-gray-400">
                compliance {scorecard.compliance.score ?? '—'} · delivery {scorecard.dora.score ?? '—'}
              </div>
            </div>
          </div>
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Compliance</span>
              <span className="text-xs text-gray-500">
                {scorecard.compliance.rulesEvaluated} rules · {scorecard.compliance.violations} viol · {scorecard.compliance.warnings} warn
              </span>
            </div>
            <Band label="Deploy frequency" level={scorecard.dora.deploymentFrequency} />
            <Band label="Change failure rate" level={scorecard.dora.changeFailureRate} />
            <Band label="Time to restore" level={scorecard.dora.meanTimeToRestore} />
            <Band label="Lead time (proxy)" level={scorecard.dora.leadTime} />
          </div>
          <p className="text-[11px] text-gray-400">DORA basis: {scorecard.dora.basis}. Lead time is a run-time proxy.</p>
        </div>
      )}
    </Card>
  );
}
