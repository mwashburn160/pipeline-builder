// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CheckCircle, XCircle } from 'lucide-react';

/** One failing entity from a rule-impact preview. */
export interface RuleImpactSample {
  entityId: string;
  entityName: string | null;
  messages: string[];
}

/**
 * Aggregate counts plus up to ten failure samples, as
 * `POST /api/compliance/subscriptions/preview/impact` returns them.
 */
export interface RuleImpact {
  total: number;
  wouldPass: number;
  wouldFail: number;
  samples: RuleImpactSample[];
}

/**
 * "If this rule applied to you today, what would fail?" — rendered the same way
 * wherever it is asked.
 *
 * RuleEditor (authoring a rule) and SubscriptionManager (browsing published
 * rules) both show this, and the numbers are the whole point: an author decides
 * whether to publish from the fail count, and a subscriber decides whether to
 * subscribe from it. Two copies of the arithmetic is two chances for one surface
 * to read `wouldFail` where the other reads `total - wouldPass`, and the reader
 * has no way to tell which they are looking at.
 *
 * `samples` is capped server-side, so the count and the list disagree by design
 * on any rule with more than ten failures — hence the explicit "+ N more",
 * computed from `wouldFail` rather than from the list length.
 */
export function RuleImpactPanel({
  impact,
  className = '',
  showPassingState = false,
}: {
  impact: RuleImpact;
  /** Extra classes on the outer panel, for callers that need their own margins. */
  className?: string;
  /** Also say so when nothing would fail. Authoring wants the reassurance; a
   *  browse list would just be noisy, since most rows pass. */
  showPassingState?: boolean;
}): React.ReactElement {
  const hidden = impact.wouldFail - impact.samples.length;

  return (
    <div className={`p-3 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 text-sm border border-indigo-200 dark:border-indigo-800 ${className}`.trim()}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">Impact on your existing entities</span>
        <span className="text-xs text-fg-muted">
          <span className={impact.wouldFail > 0 ? 'text-danger font-medium' : 'text-success'}>
            {impact.wouldFail}
          </span>
          {' / '}{impact.total}{' would fail'}
        </span>
      </div>
      {impact.samples.length > 0 && (
        <ul className="space-y-1">
          {impact.samples.map((s) => (
            <li key={s.entityId} className="flex items-start gap-1.5 text-xs text-danger">
              <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>
                <span className="font-medium">{s.entityName ?? s.entityId.slice(0, 8)}</span>
                {s.messages[0] && <span className="text-fg-muted"> — {s.messages[0]}</span>}
              </span>
            </li>
          ))}
          {hidden > 0 && (
            <li className="text-xs text-fg-muted italic">+ {hidden} more</li>
          )}
        </ul>
      )}
      {showPassingState && impact.wouldFail === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle className="h-3.5 w-3.5" /> No existing entities would fail this rule.
        </div>
      )}
    </div>
  );
}
