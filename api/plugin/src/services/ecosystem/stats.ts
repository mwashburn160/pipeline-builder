// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `plugin_stats` upkeep (docs/plans/plugin-ecosystem.md §5, §6a, W4): the
 * numbers the public directory shows and sorts by.
 *
 *  - RATINGS — a Bayesian average (prior 3.5 over 10 votes) where a
 *    verified-use review weighs 1.0 and an unverified one 0.5 (D9, G16), the
 *    raw published count, the star distribution, and the same average over the
 *    last two minor versions ("recent versions"). Recomputed for a listing on
 *    every review write that changes what is published, so the page is never
 *    stale for its own author, and again by the sweep.
 *  - INSTALLS — distinct orgs with an active explicit install OR a pipeline
 *    that references the listing (a step manifest: implicit Official use
 *    counts, since nothing else records it).
 *  - ADOPTION — distinct orgs that ran it in the last 30 days, from the
 *    manifest-attributed runtime events, plus the 30-day success rate. The
 *    `public_listings` view hides the org count below 5 (k-anonymity, G15).
 *  - HEALTH (W7) — the 0–100 score and its breakdown (api-core
 *    `computeHealthScore`) from the runtime success rate, the latest listed
 *    version's scan, release and base-image age, signature and smoke test, the
 *    README/license and the rating; and per publisher the run-weighted success
 *    rate and the install-weighted mean health of its live listings.
 *
 * The sweep is one leader-locked scheduler across replicas.
 */

import {
  computeHealthScore, createLogger, createScheduler, errorMessage, publisherHealthScore, publisherSuccessRate,
  type HealthResult, type LockRedis, type Scheduler,
} from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import {
  compareSemver, parseSemver, schema, type PluginListing, type PluginListingVersion, type PluginReview,
} from '@pipeline-builder/pipeline-data';
import { eq, sql } from 'drizzle-orm';

import { listingStats, reviews } from './reviews-store.js';
import { ACTIVE_LISTING_STATES, elevated, listings, versions } from './store.js';

const logger = createLogger('ecosystem-stats');

/** The Bayesian prior: a new listing starts at 3.5 stars, worth 10 votes (§5). */
export const RATING_PRIOR_MEAN = 3.5;
export const RATING_PRIOR_WEIGHT = 10;
/** Review weights (D9): verified use counts fully, unverified at half weight. */
export const VERIFIED_WEIGHT = 1;
export const UNVERIFIED_WEIGHT = 0.5;
/** The adoption window (distinct orgs that ran it, success rate). */
export const ADOPTION_WINDOW_DAYS = 30;
/** How often the sweep runs. */
export const STATS_INTERVAL_MS = 15 * 60_000;

type RatedReview = Pick<PluginReview, 'rating' | 'verifiedUse' | 'version'>;

/** The weighted Bayesian average of these reviews, or null when there are none. */
export function bayesianRating(rated: ReadonlyArray<Pick<PluginReview, 'rating' | 'verifiedUse'>>): number | null {
  if (rated.length === 0) return null;
  let weight = RATING_PRIOR_WEIGHT;
  let total = RATING_PRIOR_MEAN * RATING_PRIOR_WEIGHT;
  for (const r of rated) {
    const w = r.verifiedUse ? VERIFIED_WEIGHT : UNVERIFIED_WEIGHT;
    weight += w;
    total += w * r.rating;
  }
  return Math.round((total / weight) * 1000) / 1000;
}

/** `major.minor` of the listing's two newest minor lines (stable versions preferred). */
export function recentMinorLines(listingVersions: readonly string[]): Set<string> {
  const lines: string[] = [];
  const sorted = [...listingVersions].filter((v) => parseSemver(v)).sort((a, b) => compareSemver(b, a));
  for (const v of sorted) {
    const p = parseSemver(v)!;
    const line = `${p.major}.${p.minor}`;
    if (!lines.includes(line)) lines.push(line);
    if (lines.length === 2) break;
  }
  return new Set(lines);
}

/** Rating columns for one listing from its PUBLISHED reviews. */
export function ratingStats(published: readonly RatedReview[], listingVersions: readonly string[]) {
  const dist: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of published) dist[String(r.rating)] = (dist[String(r.rating)] ?? 0) + 1;
  const lines = recentMinorLines(listingVersions);
  const recent = published.filter((r) => {
    const p = r.version ? parseSemver(r.version) : null;
    return p !== null && lines.has(`${p.major}.${p.minor}`);
  });
  return {
    ratingBayes: bayesianRating(published),
    ratingCount: published.length,
    dist,
    recentRating: bayesianRating(recent),
  };
}

/** Recompute one listing's rating columns (after a review write or a moderation decision). */
export async function refreshListingRating(listingId: string): Promise<void> {
  try {
    const [published, listingVersions] = await Promise.all([
      reviews.forListing(listingId, ['published']),
      versions.forListings([listingId]),
    ]);
    await listingStats.upsert(listingId, ratingStats(published, listingVersions.map((v) => v.version)));
  } catch (err) {
    // The sweep repairs it; a review write never fails on its stats.
    incCounter('ecosystem_stats_refresh_failed_total', { scope: 'listing' });
    logger.warn('Listing rating refresh failed', { listingId, error: errorMessage(err) });
  }
}

function rowsOf<T>(res: unknown): T[] {
  const rows = (res as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** Distinct orgs per listing with an active explicit install or a pipeline that references it. */
async function installCounts(): Promise<Map<string, number>> {
  const res = await elevated((tx) => tx.execute(sql`
    SELECT o.listing_id AS "listingId", COUNT(DISTINCT o.org_id)::int AS "installCount"
      FROM (
        SELECT i.listing_id, lower(i.org_id) AS org_id
          FROM plugin_installs i
         WHERE i.status = 'active'
        UNION
        SELECT l.id AS listing_id, lower(m.org_id) AS org_id
          FROM pipeline_step_manifests m
          JOIN publishers p ON p.handle = m.plugin_publisher
          JOIN plugin_listings l ON l.publisher_id = p.id AND l.name = m.plugin_name
      ) o
     GROUP BY o.listing_id`));
  return new Map(rowsOf<{ listingId: string; installCount: unknown }>(res).map((r) => [r.listingId, num(r.installCount)]));
}

interface Adoption {
  activeOrgCount: number;
  successRate30d: number | null;
  /** Terminal runs in the window (the health score needs ≥ 20). */
  runs30d: number;
}

/** Per listing over the adoption window: distinct orgs that ran it, the success rate and the run count. */
async function adoption(): Promise<Map<string, Adoption>> {
  const res = await elevated((tx) => tx.execute(sql`
    SELECT l.id AS "listingId",
           COUNT(DISTINCT e.org_id)::int AS "activeOrgCount",
           (COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED'))::float / NULLIF(COUNT(*), 0) AS "successRate30d",
           COUNT(*)::int AS "runs30d"
      FROM pipeline_events e
      JOIN publishers p ON p.handle = e.plugin_publisher
      JOIN plugin_listings l ON l.publisher_id = p.id AND l.name = e.plugin_name
     WHERE e.event_type = 'ACTION' AND e.plugin_name IS NOT NULL
       AND e.status IN ('SUCCEEDED', 'FAILED')
       AND e.completed_at >= now() - make_interval(days => ${ADOPTION_WINDOW_DAYS})
     GROUP BY l.id`));
  return new Map(rowsOf<{ listingId: string; activeOrgCount: unknown; successRate30d: unknown; runs30d: unknown }>(res).map((r) => [r.listingId, {
    activeOrgCount: num(r.activeOrgCount),
    successRate30d: r.successRate30d === null || r.successRate30d === undefined ? null : num(r.successRate30d),
    runs30d: num(r.runs30d),
  }]));
}

/**
 * The version a listing's health describes: its `latestVersion` when that is
 * live (not yanked or paused), else the newest live one; null with none.
 */
export function currentListedVersion(
  listing: Pick<PluginListing, 'latestVersion'>,
  listingVersions: readonly PluginListingVersion[],
): PluginListingVersion | null {
  const live = listingVersions.filter((v) => !v.yankedAt && !v.pausedAt);
  return live.find((v) => v.version === listing.latestVersion)
    ?? [...live].sort((a, b) => compareSemver(b.version, a.version))[0]
    ?? null;
}

const present = (s: string | null | undefined): boolean => typeof s === 'string' && s.trim() !== '';

/** Whether a frozen spec declares a smoke test (a command string or a structured test). */
function declaresSmokeTest(spec: Record<string, unknown> | null | undefined): boolean {
  const t = spec?.smokeTest;
  if (typeof t === 'string') return t.trim() !== '';
  return t !== null && typeof t === 'object' && Object.keys(t).length > 0;
}

/** One listing's health (W7) from its row, its versions, its rating columns and its runtime. */
export function listingHealth(
  listing: Pick<PluginListing, 'latestVersion' | 'readmeHtml' | 'license'>,
  listingVersions: readonly PluginListingVersion[],
  rating: { ratingBayes: number | null; ratingCount: number },
  runtime: Pick<Adoption, 'runs30d' | 'successRate30d'> | undefined,
  now: Date = new Date(),
): HealthResult {
  const current = currentListedVersion(listing, listingVersions);
  const spec = (current?.specSnapshot ?? {}) as Record<string, unknown>;
  return computeHealthScore({
    runs30d: runtime?.runs30d ?? 0,
    successRate30d: runtime?.successRate30d ?? null,
    vulnCritical: current?.vulnCritical ?? null,
    vulnHigh: current?.vulnHigh ?? null,
    scannedAt: current?.scannedAt ?? null,
    lastReleaseAt: current?.publishedAt ?? null,
    baseImageCreatedAt: current?.baseImageCreatedAt ?? null,
    // A listed image exists only as the platform's freshly signed public/* copy.
    signed: current ? current.imageDigest !== null && current.imageRepository !== null : null,
    smokeTestDeclared: current ? declaresSmokeTest(spec) : null,
    hasReadme: present(listing.readmeHtml) || present(spec.readmeHtml as string | undefined),
    hasLicense: present(listing.license) || present(spec.license as string | undefined),
    ratingBayes: rating.ratingBayes,
    ratingCount: rating.ratingCount,
  }, now);
}

/** Write a publisher's W7 roll-ups (without touching `updated_at`: the profile didn't change). */
async function writePublisherRollup(publisherId: string, successRate30d: number | null, healthScore: number | null): Promise<void> {
  await elevated(async (tx) => {
    await tx.update(schema.publisher).set({ successRate30d, healthScore }).where(eq(schema.publisher.id, publisherId));
  });
}

/** One sweep over every listing. Returns how many listings were written. */
export async function refreshAllStats(): Promise<{ listings: number; failures: number }> {
  const all: PluginListing[] = await listings.list();
  const ids = all.map((l) => l.id);
  const [published, listingVersions, installs, runtime] = await Promise.all([
    reviews.withStatus(['published'], 1_000_000),
    versions.forListings(ids),
    installCounts(),
    adoption(),
  ]);
  const reviewsBy = new Map<string, PluginReview[]>();
  for (const r of published) reviewsBy.set(r.listingId, [...(reviewsBy.get(r.listingId) ?? []), r]);
  const versionsBy = new Map<string, PluginListingVersion[]>();
  for (const v of listingVersions) versionsBy.set(v.listingId, [...(versionsBy.get(v.listingId) ?? []), v]);

  let failures = 0;
  const now = new Date();
  // Per publisher: its live listings' health, installs and runtime (the roll-ups).
  const rollups = new Map<string, Array<{ healthScore: number | null; installCount: number; successRate30d: number | null; runs30d: number }>>();
  for (const listing of all) {
    const id = listing.id;
    const run = runtime.get(id);
    const listingVersionRows = versionsBy.get(id) ?? [];
    const rating = ratingStats(reviewsBy.get(id) ?? [], listingVersionRows.map((v) => v.version));
    const health = listingHealth(listing, listingVersionRows, rating, run, now);
    const installCount = installs.get(id) ?? 0;
    if ((ACTIVE_LISTING_STATES as readonly string[]).includes(listing.state)) {
      rollups.set(listing.publisherId, [...(rollups.get(listing.publisherId) ?? []), {
        healthScore: health.score, installCount, successRate30d: run?.successRate30d ?? null, runs30d: run?.runs30d ?? 0,
      }]);
    }
    try {
      await listingStats.upsert(id, {
        ...rating,
        installCount,
        activeOrgCount: run?.activeOrgCount ?? 0,
        successRate30d: run?.successRate30d ?? null,
        healthScore: health.score,
        healthBreakdown: health.breakdown,
      });
    } catch (err) {
      failures++;
      logger.warn('Listing stats write failed', { listingId: id, error: errorMessage(err) });
    }
  }
  // Every publisher that has listings gets its roll-up; one whose listings all
  // left the directory resets to NULL.
  for (const publisherId of new Set(all.map((l) => l.publisherId))) {
    const rows = rollups.get(publisherId) ?? [];
    try {
      await writePublisherRollup(publisherId, publisherSuccessRate(rows), publisherHealthScore(rows));
    } catch (err) {
      failures++;
      logger.warn('Publisher roll-up write failed', { publisherId, error: errorMessage(err) });
    }
  }
  if (failures > 0) incCounter('ecosystem_stats_refresh_failed_total', { scope: 'sweep' }, failures);
  setGauge('ecosystem_stats_last_sweep_timestamp_seconds', {}, Math.floor(Date.now() / 1000));
  return { listings: ids.length, failures };
}

/** Build (not start) the sweep: every 15 minutes, leader-locked on the shared Redis. */
export function createEcosystemStatsScheduler(redis: () => LockRedis): Scheduler {
  return createScheduler({
    name: 'ecosystem-stats',
    intervalMs: STATS_INTERVAL_MS,
    startupDelayMs: 90_000,
    lock: { redis, key: 'ecosystem-stats:leader', ttlMs: 30 * 60_000 },
    run: async () => { await refreshAllStats(); },
  });
}
