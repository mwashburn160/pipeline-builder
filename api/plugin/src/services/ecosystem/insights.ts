// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The publisher dashboard's Insights tab (docs/plugin-publishing.md
 * ): per listing, what the publisher needs to run it — installs, how many
 * orgs actually ran it (k-anonymous: below {@link K_ANONYMITY} it reads "<5",
 * never the exact small number), the 30-day success rate, the rating trend
 * (monthly average of published reviews over the last 12 months), open review
 * reports, open (published) advisories and the health score with its breakdown.
 *
 * Read-only, and only ever about the caller org's OWN publisher. Security
 * review reports are excluded from the report count: they route privately to
 * the advisory path, and their existence is not the publisher's to see
 * until a moderator acts.
 */

import type { PluginReview, PluginReviewReport, PluginStats, Publisher } from '@pipeline-builder/pipeline-data';

import { advisoryStore } from './advisories-store.js';
import type { Caller } from './context.js';
import { listingStats, reports, reviews } from './reviews-store.js';
import { listings, publishers } from './store.js';
import { roundTo } from './util.js';

/** Adoption counts below this are shown as "<5". */
export const K_ANONYMITY = 5;
/** Months in the rating trend. */
export const RATING_TREND_MONTHS = 12;

/** A k-anonymous org count: the number at or above the threshold, else null with a "<5" label. */
export function kAnonymousCount(n: number, k = K_ANONYMITY): { count: number | null; label: string } {
  return n >= k ? { count: n, label: String(n) } : { count: null, label: `<${k}` };
}

export interface RatingTrendPoint {
  /** `YYYY-MM` (UTC). */
  month: string;
  /** Mean star rating of reviews written that month (2 decimals), null with none. */
  average: number | null;
  count: number;
}

const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** The last `months` calendar months (oldest first, the current month last), each with its review average. Pure. */
export function monthlyRatingTrend(
  rated: ReadonlyArray<Pick<PluginReview, 'rating' | 'createdAt'>>,
  now: Date = new Date(),
  months = RATING_TREND_MONTHS,
): RatingTrendPoint[] {
  const buckets = new Map<string, { sum: number; count: number }>();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const key = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
    keys.push(key);
    buckets.set(key, { sum: 0, count: 0 });
  }
  for (const r of rated) {
    const b = buckets.get(monthKey(new Date(r.createdAt)));
    if (!b) continue;
    b.sum += r.rating;
    b.count++;
  }
  return keys.map((month) => {
    const b = buckets.get(month)!;
    return { month, average: b.count === 0 ? null : roundTo(b.sum / b.count, 2), count: b.count };
  });
}

/** Unresolved, non-security reports per listing. Pure. */
export function openReportCounts(
  listingReviews: ReadonlyArray<Pick<PluginReview, 'id' | 'listingId'>>,
  reportRows: ReadonlyArray<Pick<PluginReviewReport, 'reviewId' | 'resolvedAt' | 'category'>>,
): Map<string, number> {
  const listingOf = new Map(listingReviews.map((r) => [r.id, r.listingId]));
  const out = new Map<string, number>();
  for (const rep of reportRows) {
    if (rep.resolvedAt || rep.category === 'security') continue;
    const listingId = listingOf.get(rep.reviewId);
    if (listingId) out.set(listingId, (out.get(listingId) ?? 0) + 1);
  }
  return out;
}

const round3 = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : Math.round(n * 1000) / 1000);

function publisherSummary(p: Publisher) {
  return {
    handle: p.handle,
    displayName: p.displayName,
    tier: p.tier,
    healthScore: p.healthScore ?? null,
    successRate30d: round3(p.successRate30d),
  };
}

/** GET /plugins/publisher/insights — the caller org's publisher and per-listing insights. */
export async function publisherInsights(caller: Caller, now: Date = new Date()) {
  const publisher = await publishers.byOrg(caller.orgId);
  if (!publisher) return { publisher: null, listings: [] };
  const rows = await listings.list({ publisherId: publisher.id });
  const ids = rows.map((l) => l.id);
  const [statsRows, allReviews, advisories] = await Promise.all([
    listingStats.byListings(ids),
    reviews.forListings(ids),
    advisoryStore.list({ publisherId: publisher.id, states: ['published'] }),
  ]);
  const statsBy = new Map<string, PluginStats>(statsRows.map((s) => [s.listingId, s]));
  const reportRows = await reports.forReviews(allReviews.map((r) => r.id));
  const openReports = openReportCounts(allReviews, reportRows);

  return {
    publisher: publisherSummary(publisher),
    listings: rows.map((l) => {
      const s = statsBy.get(l.id);
      const published = allReviews.filter((r) => r.listingId === l.id && r.status === 'published');
      return {
        listingId: l.id,
        name: l.name,
        state: l.state,
        paused: l.pausedAt !== null,
        latestVersion: l.latestVersion,
        installCount: s?.installCount ?? 0,
        activeOrgs: kAnonymousCount(s?.activeOrgCount ?? 0),
        successRate30d: round3(s?.successRate30d),
        healthScore: s?.healthScore === null || s?.healthScore === undefined ? null : Math.round(s.healthScore),
        healthBreakdown: s?.healthBreakdown ?? null,
        rating: s && s.ratingCount > 0 && s.ratingBayes !== null
          ? { score: roundTo(s.ratingBayes, 2), count: s.ratingCount }
          : null,
        ratingTrend: monthlyRatingTrend(published, now),
        openReviewReports: openReports.get(l.id) ?? 0,
        openAdvisories: advisories.filter((a) => a.listingId === l.id).length,
        statsUpdatedAt: s?.updatedAt ? new Date(s.updatedAt).toISOString() : null,
      };
    }),
  };
}
export type PublisherInsights = Awaited<ReturnType<typeof publisherInsights>>;
