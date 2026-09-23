// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Activity } from 'lucide-react';
import { HEALTH_BAND_LABELS, healthBand, healthRows, HEALTH_COMPONENT_MISSING, type HealthBand } from '@/lib/public-directory/health';
import type { HealthBreakdown } from '@/lib/public-directory/types';
import { Card } from '@/components/ui/Card';

const BAND_CLS: Record<HealthBand, string> = {
  good: 'bg-success-bg text-success-strong border-success-border',
  fair: 'bg-warning-bg text-warning-strong border-warning-border',
  poor: 'bg-danger-bg text-danger-strong border-danger-border',
  unknown: 'bg-surface-muted text-fg-muted border-default',
};

/**
 * The listing's health score as a small pill: "Health 86". Nothing at all
 * when there is no score (a new listing isn't penalised visually). The band is
 * spelled out for screen readers, so colour is never the only signal.
 */
export function HealthBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return null;
  const band = healthBand(score);
  return (
    <span
      data-health-band={band}
      title={`Health score ${score}/100 (${HEALTH_BAND_LABELS[band].toLowerCase()}): runtime success, vulnerabilities, freshness, signing, smoke test, docs and rating.`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${BAND_CLS[band]}`}
    >
      <Activity className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Health {score}</span>
      <span className="sr-only">out of 100, {HEALTH_BAND_LABELS[band]}</span>
    </span>
  );
}

/** The per-signal breakdown behind the score, as an accessible table with meters. */
export function HealthBreakdownPanel({ score, breakdown, successRate30d }: {
  score: number | null | undefined;
  breakdown: HealthBreakdown | null | undefined;
  successRate30d?: number | null;
}) {
  const rows = healthRows(breakdown);
  return (
    <Card as="section" aria-labelledby="health-heading" className="space-y-3 p-4" data-testid="health-breakdown">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="health-heading" className="text-sm font-semibold text-fg">Health</h2>
        {score === null || score === undefined
          ? <span className="text-xs text-fg-subtle">Not enough data yet</span>
          : <HealthBadge score={score} />}
      </div>
      {rows.length === 0
        ? <p className="text-sm text-fg-muted">The health score appears once the directory has at least three signals for this plugin.</p>
        : (
          <table className="w-full text-sm">
            <caption className="sr-only">Health score signals, their scores and weights</caption>
            <thead>
              <tr className="text-left text-xs text-fg-subtle">
                <th scope="col" className="py-1 font-medium">Signal</th>
                <th scope="col" className="py-1 font-medium">Score</th>
                <th scope="col" className="py-1 text-right font-medium">Weight</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = r.score === null ? null : Math.round(r.score * 100);
                return (
                  <tr key={r.id} className="border-t border-default">
                    <th scope="row" className="py-2 pr-2 text-left font-normal text-fg">{r.label}</th>
                    <td className="py-2 pr-2">
                      {pct === null
                        ? <span className="text-xs text-fg-subtle">{HEALTH_COMPONENT_MISSING[r.id] ?? 'Not enough data'} — not counted</span>
                        : (
                          <span className="flex items-center gap-2">
                            <meter
                              min={0} max={100} low={50} high={80} optimum={100} value={pct}
                              aria-label={`${r.label}: ${pct} out of 100`}
                              className="h-2 w-24"
                            />
                            <span className="tabular-nums text-fg-muted">{pct}</span>
                          </span>
                        )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-fg-muted">
                      {r.share === null ? <span className="text-fg-subtle">{r.weight}</span> : `${Math.round(r.share * 100)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      {typeof successRate30d === 'number' && (
        <p className="text-xs text-fg-subtle">{Math.round(successRate30d * 1000) / 10}% of runs succeeded in the last 30 days.</p>
      )}
      <p className="text-xs text-fg-subtle">
        Signals without enough data are left out and the rest reweighted. Weight shows each counted signal&apos;s share of the score.
      </p>
    </Card>
  );
}
