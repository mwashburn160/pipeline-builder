// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Fragment, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { HealthBadge, HealthBreakdownPanel } from '@/components/public-directory/HealthBadge';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { PublisherListingInsight } from '@/types/ecosystem';

const pct = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`);

/**
 * Monthly rating trend as a tiny bar sparkline, with the numbers in an
 * sr-only list so the chart is never the only way to read it.
 */
function RatingTrend({ trend }: { trend: PublisherListingInsight['ratingTrend'] }) {
  const rated = trend.filter((p) => p.average !== null);
  if (rated.length === 0) return <span className="text-xs text-fg-subtle">No reviews in 12 months</span>;
  return (
    <span className="inline-flex items-end gap-0.5" data-testid="rating-trend">
      {trend.map((p) => (
        <span
          key={p.month}
          aria-hidden="true"
          title={p.average === null ? `${p.month}: no reviews` : `${p.month}: ${p.average} (${p.count})`}
          className={p.average === null ? 'h-1 w-1.5 rounded-sm bg-surface-muted' : 'w-1.5 rounded-sm text-info-strong'}
          style={p.average === null ? undefined : { height: `${Math.max(4, Math.round((p.average / 5) * 20))}px`, backgroundColor: 'currentColor' }}
        />
      ))}
      <span className="sr-only">
        {rated.map((p) => `${p.month}: ${p.average} stars from ${p.count} review${p.count === 1 ? '' : 's'}`).join('; ')}
      </span>
    </span>
  );
}

/**
 * The publisher dashboard's Insights tab: per listing, installs,
 * k-anonymous active orgs ("<5" below five), 30-day success rate, rating and
 * its 12-month trend, open review reports and advisories, and the health score
 * with its breakdown on demand. Read-only (`plugins:read`).
 */
export function PublisherInsightsPanel() {
  const q = useFetch(async (signal) => {
    const res = await api.getPublisherInsights({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load insights');
    return res.data;
  }, []);
  const [open, setOpen] = useState<string | null>(null);

  if (q.error) return <RetryError message={formatError(q.error, 'Failed to load insights')} onRetry={q.refetch} />;
  if (!q.data) return <Skeleton className="h-40 w-full" />;
  const { publisher, listings } = q.data;
  if (!publisher || listings.length === 0) {
    return <EmptyState icon={BarChart3} title="No listings yet" description="Insights appear once a listing is published to the directory." />;
  }

  return (
    <SectionCard
      icon={BarChart3}
      title="Insights"
      description="How your listings are doing. Org counts under five are shown as “<5” to protect installers’ privacy. Stats refresh every 15 minutes."
    >
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        <span className="flex items-center gap-2">
          <span className="text-fg-muted">Publisher health</span>
          {publisher.healthScore === null ? <span className="text-fg-subtle">Not enough data</span> : <HealthBadge score={publisher.healthScore} />}
        </span>
        <span><span className="text-fg-muted">30-day success rate</span> <span className="tabular-nums text-fg">{pct(publisher.successRate30d)}</span></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <caption className="sr-only">Per-listing insights</caption>
          <thead>
            <tr className="text-left text-xs text-fg-subtle">
              <th scope="col" className="py-2 pr-3 font-medium">Listing</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Installs</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Active orgs (30d)</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Success (30d)</th>
              <th scope="col" className="py-2 pr-3 font-medium">Rating</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Open reports</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Open advisories</th>
              <th scope="col" className="py-2 font-medium">Health</th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <Fragment key={l.listingId}>
                <tr className="border-t border-default align-middle">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <span className="font-mono text-fg">{l.name}</span>
                    {l.latestVersion && <span className="ml-2 font-mono text-xs text-fg-subtle">v{l.latestVersion}</span>}
                    {(l.paused || l.state !== 'listed') && (
                      <span className="ml-2 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">{l.paused ? 'paused' : l.state}</span>
                    )}
                  </th>
                  <td className="py-2 pr-3 text-right tabular-nums">{l.installCount}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {l.activeOrgs.count === null
                      ? <span title="Fewer than five organizations — hidden to protect their privacy">{l.activeOrgs.label}<span className="sr-only"> (fewer than five)</span></span>
                      : l.activeOrgs.label}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pct(l.successRate30d)}</td>
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{l.rating ? `${l.rating.score.toFixed(1)} (${l.rating.count})` : '—'}</span>
                      <RatingTrend trend={l.ratingTrend} />
                    </span>
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${l.openReviewReports > 0 ? 'font-medium text-warning-strong' : ''}`}>{l.openReviewReports}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${l.openAdvisories > 0 ? 'font-medium text-danger-strong' : ''}`}>{l.openAdvisories}</td>
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      {l.healthScore === null ? <span className="text-xs text-fg-subtle">—</span> : <HealthBadge score={l.healthScore} />}
                      <button
                        type="button"
                        className="action-link text-xs"
                        aria-expanded={open === l.listingId}
                        aria-controls={`health-${l.listingId}`}
                        onClick={() => setOpen(open === l.listingId ? null : l.listingId)}
                      >
                        {open === l.listingId ? 'Hide' : 'Details'}<span className="sr-only"> for {l.name}</span>
                      </button>
                    </span>
                  </td>
                </tr>
                {open === l.listingId && (
                  <tr id={`health-${l.listingId}`}>
                    <td colSpan={8} className="pb-4">
                      <HealthBreakdownPanel score={l.healthScore} breakdown={l.healthBreakdown} successRate30d={l.successRate30d} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
