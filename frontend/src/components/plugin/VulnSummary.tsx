// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { describeFinding, gateThresholdLabel, gatedCount, normalizeScanFlag, type VulnFacts } from '@/lib/plugin-vulns';

/** `2 fixable / 5 Critical`, or `5 Critical` when the fixable count is unknown. */
function countLabel(total: number, fixable: number | null | undefined, severity: string): string {
  return fixable == null ? `${total} ${severity}` : `${fixable} fixable / ${total} ${severity}`;
}

/**
 * A plugin version's vulnerability standing as badges: Critical and High, each
 * as fixable / total; "Unscanned" when the image was stored without a scan; and
 * "Flagged by rescan" when a nightly rescan found gated findings the build did
 * not have. `details` also lists the flag's top findings with their fixed
 * versions, for the detail views; the badge's tooltip carries them everywhere.
 *
 * WHICH SEVERITIES GATE IS A DEPLOYMENT CHOICE (`PLUGIN_VULN_FAIL_ON`:
 * `critical` by default, or `high` for both), so the severity colouring reads
 * the flag's own `failOn` rather than assuming Criticals. It used to assume: a
 * version with no Criticals and eight fixable Highs showed a yellow "High"
 * badge next to a build that refused it, and the tooltip said only fixable
 * Criticals counted.
 */
export function VulnSummary({ facts, details = false, quiet = false, className = '' }: {
  facts: VulnFacts;
  details?: boolean;
  /** Render nothing for a clean, unflagged version (dense lists). */
  quiet?: boolean;
  className?: string;
}) {
  // The public directory carries only `scanFlaggedAt`; tenant rows also the flag's counts and findings.
  const flagged = !!(facts.scanFlaggedAt || facts.scanFlag);
  const flag = flagged ? normalizeScanFlag(facts.scanFlag) : null;
  const unscanned = facts.vulnCritical == null && facts.vulnHigh == null;
  const critical = facts.vulnCritical ?? 0;
  const high = facts.vulnHigh ?? 0;
  if (quiet && !flagged && !unscanned && critical === 0 && high === 0) return null;
  // The threshold the FLAG was raised at, when we have a flag; otherwise the
  // platform default. Never re-derived from the counts.
  const failOn = flag?.failOn ?? 'critical';
  const threshold = gateThresholdLabel(failOn);
  const gated = gatedCount(facts, failOn);
  // V4: name the threshold and the floor it breached, rather than hardcoding
  // "Critical" — `failOnLabel` and the flag's `maxFindings` exist for this.
  const flagTitle = flag
    ? [
      `A rescan found ${flag.gated} gated ${threshold} and ${flag.high} fixable High finding(s)`
        + ` — this deployment gates on ${threshold}`
        + (flag.maxFindings != null ? ` above a floor of ${flag.maxFindings}` : '')
        + '. Rebuild or upgrade.',
      ...flag.findings.map(describeFinding),
    ].join('\n')
    : `A rescan found gated findings (${threshold}). Rebuild or upgrade.`;

  return (
    <span className={`inline-flex flex-col gap-1 ${className}`} data-testid="vuln-summary">
      <span className="inline-flex flex-wrap items-center gap-1">
        {unscanned ? (
          <span title="Stored without a vulnerability scan" className="inline-block" data-testid="vuln-unscanned">
            <Badge color="yellow">Unscanned</Badge>
          </span>
        ) : critical === 0 && high === 0 ? (
          <span data-testid="vuln-clean"><Badge color="green">No Critical or High</Badge></span>
        ) : (
          <>
            {critical > 0 && (
              <span
                title={`Fixable findings have a fixed version available; only those count toward the build gates. This deployment gates on ${threshold}.`}
                className="inline-block"
                data-testid="vuln-critical"
              >
                <Badge color={(facts.vulnCriticalFixable ?? critical) > 0 ? 'red' : 'gray'}>
                  {countLabel(critical, facts.vulnCriticalFixable, 'Critical')}
                </Badge>
              </span>
            )}
            {high > 0 && (
              // RED when this deployment gates on High — a yellow badge beside a
              // refused build is the bug this replaces.
              <span
                title={`This deployment gates on ${threshold}.`}
                className="inline-block"
                data-testid="vuln-high"
              >
                <Badge color={failOn === 'high' && (facts.vulnHighFixable ?? high) > 0 ? 'red' : 'yellow'}>
                  {countLabel(high, facts.vulnHighFixable, 'High')}
                </Badge>
              </span>
            )}
            {/* Only when the threshold spans BOTH severities: under the default
                the gated count is just the fixable-Critical count, and a third
                badge repeating it is noise. */}
            {failOn === 'high' && gated != null && gated > 0 && (
              <span
                title={`${gated} finding(s) count toward this deployment's build gate (${threshold}).`}
                className="inline-block"
                data-testid="vuln-gated"
              >
                <Badge color="red">{gated} gated</Badge>
              </span>
            )}
          </>
        )}
        {flagged && (
          <span title={flagTitle} className="inline-block" data-testid="vuln-flagged">
            <Badge color="red">
              <ShieldAlert className="mr-1 h-3 w-3" aria-hidden />Flagged by rescan
            </Badge>
          </span>
        )}
      </span>
      {details && flag && flag.findings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-danger-strong" aria-label="Rescan findings" data-testid="vuln-flag-findings">
          {flag.findings.map((f) => <li key={f.id} className="font-mono">{describeFinding(f)}</li>)}
        </ul>
      )}

    </span>
  );
}
