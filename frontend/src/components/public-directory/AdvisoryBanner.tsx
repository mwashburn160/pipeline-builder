// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The plugin page's security-advisory banner and per-version markers (plan W8). */
import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { severityColor, severityLabel, severityRank, sortBySeverity } from '@/lib/advisories';
import type { ListingAdvisory } from '@/lib/public-directory/types';

/**
 * Every published advisory on the listing, highest severity first. Details are
 * server-rendered, server-SANITIZED HTML — injected as-is, like the README.
 * Renders nothing when the listing has no advisory.
 */
export function AdvisoryBanner({ advisories }: { advisories: ListingAdvisory[] }) {
  if (advisories.length === 0) return null;
  const sorted = sortBySeverity(advisories);
  return (
    <Callout variant="danger" icon={ShieldAlert} title="Active security advisory">
      <ul className="mt-1 space-y-3" data-testid="advisory-banner">
        {sorted.map((a) => (
          <li key={a.id} className="space-y-1" data-testid={`advisory-${a.id}`}>
            <p className="flex flex-wrap items-center gap-2">
              <Badge color={severityColor(a.severity)}>{severityLabel(a.severity)}</Badge>
              <span className="font-medium text-fg">{a.summary}</span>
            </p>
            <p className="text-xs text-fg-muted">
              Affects <code className="font-mono">{a.affectedRange}</code>
              {' · '}
              {a.fixedVersion ? <>fixed in <code className="font-mono">{a.fixedVersion}</code></> : 'no fix yet'}
              {' · '}
              <span className="font-mono">{a.id}</span>
            </p>
            {a.cveIds.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="CVE ids">
                {a.cveIds.map((c) => <li key={c}><code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-fg">{c}</code></li>)}
              </ul>
            )}
            {a.detailsHtml && (
              <details className="text-fg">
                <summary className="cursor-pointer text-xs font-medium">Details</summary>
                <div className="pb-readme mt-2 text-sm" data-testid="advisory-details" dangerouslySetInnerHTML={{ __html: a.detailsHtml }} />
              </details>
            )}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * A version's advisory marker: the most severe published advisory covering it.
 * Nothing when no advisory covers the version.
 */
export function VersionAdvisoryMarker({ advisoryIds, advisories }: { advisoryIds: string[]; advisories: ListingAdvisory[] }) {
  if (advisoryIds.length === 0) return null;
  const covering = advisories.filter((a) => advisoryIds.includes(a.id));
  const worst = covering.length > 0
    ? covering.reduce((w, a) => (severityRank(a.severity) < severityRank(w.severity) ? a : w))
    : null;
  const label = worst ? `${severityLabel(worst.severity)} advisory` : 'Advisory';
  const title = covering.length > 0 ? covering.map((a) => `${a.id}: ${a.summary}`).join('\n') : undefined;
  return (
    <span title={title} data-testid="version-advisory">
      <Badge color={worst ? severityColor(worst.severity) : 'red'}>
        {label}{advisoryIds.length > 1 ? ` (+${advisoryIds.length - 1})` : ''}
      </Badge>
    </span>
  );
}
