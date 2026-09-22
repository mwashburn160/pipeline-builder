// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * W7 quality signals (plugin ecosystem §6 W7) against the in-memory database:
 * the stats sweep's per-listing health score + breakdown and the publisher
 * roll-ups; the base-image age recorded on a listed version at publish; the
 * authenticated listing views; and the publisher Insights (k-anonymous
 * adoption, rating trend, open reports and advisories).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';

import { SYSTEM_ORG, loader, pluginRow, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const stats = await import('../src/services/ecosystem/stats.js');
const insights = await import('../src/services/ecosystem/insights.js');
const publishersSvc = await import('../src/services/ecosystem/publishers.js');
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const installs = await import('../src/services/ecosystem/installs.js');
await wireEcosystemHarness(h);

const { db } = h;
const dialect = new PgDialect();
const DIGEST = `sha256:${'c'.repeat(64)}`;
const NOW = new Date('2026-09-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

beforeEach(() => {
  db.reset();
  db.execute.handler = () => ({ rows: [] });
  decisions.setBaseImageProbeForTests(async () => null);
});

const statsRow = (listingId: string) => (db.tables.plugin_stats ?? []).find((s) => s.listingId === listingId);

/** A listing with one live version that scores on every static component. */
function seedHealthy(publisherId: string, name: string, extra: { listing?: Record<string, unknown>; version?: Record<string, unknown> } = {}) {
  const listing = db.seed('plugin_listings', {
    publisherId, name, latestVersion: '1.0.0', readmeHtml: '<p>readme</p>', license: 'MIT', ...extra.listing,
  });
  const version = db.seed('plugin_listing_versions', {
    listingId: listing.id,
    version: '1.0.0',
    imageDigest: DIGEST,
    imageRepository: `public/x/${name}`,
    specSnapshot: { smokeTest: 'lint --version' },
    publishedBy: 'system',
    vulnCritical: 0,
    vulnHigh: 0,
    scannedAt: new Date(),
    publishedAt: new Date(),
    ...extra.version,
  });
  return { listing, version };
}

describe('listingHealth / currentListedVersion', () => {
  const v = (version: string, over: Record<string, unknown> = {}) => ({
    version,
    yankedAt: null,
    pausedAt: null,
    imageDigest: DIGEST,
    imageRepository: 'public/a/b',
    specSnapshot: {},
    vulnCritical: 0,
    vulnHigh: 0,
    scannedAt: daysAgo(1),
    publishedAt: daysAgo(1),
    baseImageCreatedAt: null,
    ...over,
  }) as any;

  it('describes the latest live version, else the newest live one', () => {
    expect(stats.currentListedVersion({ latestVersion: '1.2.0' }, [v('1.2.0'), v('1.1.0')])?.version).toBe('1.2.0');
    expect(stats.currentListedVersion({ latestVersion: '1.2.0' }, [v('1.2.0', { yankedAt: new Date() }), v('1.1.0'), v('1.0.0')])?.version).toBe('1.1.0');
    expect(stats.currentListedVersion({ latestVersion: null }, [v('1.0.0', { pausedAt: new Date() })])).toBeNull();
  });

  it('scores the components from the version, the listing, the rating and the runtime', () => {
    const r = stats.listingHealth(
      { latestVersion: '1.0.0', readmeHtml: '<p>x</p>', license: null },
      [v('1.0.0', { specSnapshot: { smokeTest: { command: 'x --version' } }, vulnHigh: 2, baseImageCreatedAt: daysAgo(10) })],
      { ratingBayes: 4, ratingCount: 5 },
      { runs30d: 40, successRate30d: 0.5 },
      NOW,
    );
    expect(r.breakdown).toMatchObject({
      runtime: { score: 0.5, weight: 25 },
      vulns: { score: 0.8, weight: 20 },
      freshness: { score: 1, weight: 15 },
      signed: { score: 1, weight: 10 },
      smokeTest: { score: 1, weight: 10 },
      docs: { score: 0.5, weight: 10 },
      rating: { score: 0.8, weight: 10 },
    });
    // (12.5 + 16 + 15 + 10 + 10 + 5 + 8) / 100
    expect(r.score).toBe(77);
  });

  it('drops runtime below 20 runs and the rating below 3 reviews; an unsigned, smoke-less version scores 0 there', () => {
    const r = stats.listingHealth(
      { latestVersion: '1.0.0', readmeHtml: null, license: null },
      [v('1.0.0', { imageRepository: null, specSnapshot: { license: 'MIT', smokeTest: '  ' } })],
      { ratingBayes: 5, ratingCount: 2 },
      { runs30d: 19, successRate30d: 1 },
      NOW,
    );
    expect(r.breakdown.runtime.score).toBeNull();
    expect(r.breakdown.rating.score).toBeNull();
    expect(r.breakdown.signed.score).toBe(0);
    expect(r.breakdown.smokeTest.score).toBe(0);
    // The frozen spec's license counts when the listing has none.
    expect(r.breakdown.docs.score).toBe(0.5);
  });

  it('has only the docs component (so no score) for a listing with no live version', () => {
    const r = stats.listingHealth({ latestVersion: null, readmeHtml: null, license: 'MIT' }, [], { ratingBayes: null, ratingCount: 0 }, undefined, NOW);
    expect(r.score).toBeNull();
  });
});

describe('the stats sweep (W7)', () => {
  it('writes each listing\'s health score + breakdown and the publisher roll-ups', async () => {
    const { acme, official } = seedPublishers(db);
    const a = seedHealthy(acme.id, 'lint');
    const b = seedHealthy(acme.id, 'fmt', { listing: { readmeHtml: null, license: null }, version: { specSnapshot: {} } });
    const gone = seedHealthy(acme.id, 'old', { listing: { state: 'suspended' } });
    db.execute.handler = (q) => {
      const text = dialect.sqlToQuery(q as never).sql;
      if (text.includes('plugin_installs')) return { rows: [{ listingId: a.listing.id, installCount: 30 }, { listingId: b.listing.id, installCount: 10 }] };
      if (text.includes('pipeline_events')) {
        return {
          rows: [
            { listingId: a.listing.id, activeOrgCount: 7, successRate30d: 1, runs30d: 30 },
            { listingId: b.listing.id, activeOrgCount: 2, successRate30d: 0.5, runs30d: 10 },
          ],
        };
      }
      return { rows: [] };
    };
    expect(await stats.refreshAllStats()).toEqual({ listings: 3, failures: 0 });

    // lint: runtime 1, vulns 1, freshness 1, signed 1, smoke 1, docs 1 → 100.
    expect(statsRow(a.listing.id)).toMatchObject({ healthScore: 100, successRate30d: 1, installCount: 30 });
    expect(statsRow(a.listing.id)!.healthBreakdown).toMatchObject({ runtime: { score: 1, weight: 25 }, rating: { score: null, weight: 10 } });
    // fmt: runtime dropped (10 runs); vulns 1 (20) + fresh 1 (15) + signed 1 (10) + smoke 0 + docs 0 → 45 / 65 = 69.
    expect(statsRow(b.listing.id)).toMatchObject({ healthScore: 69 });
    // A suspended listing still gets its own score, but stays out of the publisher roll-up.
    expect(statsRow(gone.listing.id)).toMatchObject({ healthScore: 100 });

    const acmeRow = db.tables.publishers!.find((p) => p.id === acme.id)!;
    // Install-weighted over live listings only: (100·30 + 69·10) / 40 = 92.25 → 92.
    expect(acmeRow.healthScore).toBe(92);
    // Run-weighted: (30·1 + 10·0.5) / 40.
    expect(acmeRow.successRate30d).toBe(0.875);
    // A publisher with no listings is left alone.
    expect(db.tables.publishers!.find((p) => p.id === official.id)!.healthScore).toBeNull();
  });

  it('resets a publisher whose listings all left the directory', async () => {
    const { acme } = seedPublishers(db);
    seedHealthy(acme.id, 'lint', { listing: { state: 'suspended' } });
    db.tables.publishers!.find((p) => p.id === acme.id)!.healthScore = 90;
    await stats.refreshAllStats();
    expect(db.tables.publishers!.find((p) => p.id === acme.id)).toMatchObject({ healthScore: null, successRate30d: null });
  });

  it('reads the run count from the runtime events', async () => {
    const { acme } = seedPublishers(db);
    seedHealthy(acme.id, 'lint');
    const seen: string[] = [];
    db.execute.handler = (q) => { seen.push(dialect.sqlToQuery(q as never).sql); return { rows: [] }; };
    await stats.refreshAllStats();
    expect(seen.find((s) => s.includes('pipeline_events'))).toMatch(/COUNT\(\*\)::int AS "runs30d"/);
  });
});

describe('base-image age at publish', () => {
  it('records the probe\'s result on the listed version, and publishes without it when the probe has none', async () => {
    seedPublishers(db);
    const created = new Date('2026-08-01T00:00:00Z');
    const probed: string[] = [];
    decisions.setBaseImageProbeForTests(async (plugin) => { probed.push(plugin.name); return plugin.name === 'lint' ? created : null; });
    const lint = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, createdBy: 'sa-loader' }));
    const fmt = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, name: 'fmt', createdBy: 'sa-loader' }));
    expect(await requestsSvc.submitAfterBuild(loader() as any, lint.id)).toMatchObject({ status: 'approved' });
    expect(await requestsSvc.submitAfterBuild(loader() as any, fmt.id)).toMatchObject({ status: 'approved' });
    expect(probed).toEqual(['lint', 'fmt']);
    const byListing = (name: string) => {
      const listing = db.tables.plugin_listings!.find((l) => l.name === name)!;
      return db.tables.plugin_listing_versions!.find((v) => v.listingId === listing.id)!;
    };
    expect(byListing('lint').baseImageCreatedAt).toEqual(created);
    expect(byListing('fmt').baseImageCreatedAt).toBeNull();
  });
});

describe('authenticated views carry the health score', () => {
  it('the publisher\'s own listings, the publisher itself and the in-app catalog', async () => {
    const { acme } = seedPublishers(db);
    const { listing } = seedHealthy(acme.id, 'lint');
    db.seed('plugin_stats', { listingId: listing.id, healthScore: 81.6, healthBreakdown: { docs: { score: 1, weight: 10 } }, installCount: 3 });
    db.tables.publishers!.find((p) => p.id === acme.id)!.healthScore = 81;
    const caller = tenant() as any;
    const [own] = await publishersSvc.ownListings(caller);
    expect(own).toMatchObject({ healthScore: 82, healthBreakdown: { docs: { score: 1, weight: 10 } } });
    expect(own!.versions![0]).toHaveProperty('baseImageCreatedAt', null);
    expect((await publishersSvc.publisherState(caller)).publisher).toMatchObject({ healthScore: 81, successRate30d: null });
    const member = tenant({ userId: 'u-m', orgId: 'org-b', permissions: ['plugins:read', 'plugins:install'] }) as any;
    db.seed('plugin_install_policies', { orgId: 'org-b', allowedTiers: ['official', 'verified', 'community', 'unverified'], requireApprovalTiers: [] });
    const { listings } = await installs.catalog(member, {});
    expect(listings.find((e) => e.listing.name === 'lint')).toMatchObject({ healthScore: 82 });
  });
});

describe('publisher insights', () => {
  it('k-anonymizes org counts below 5', () => {
    expect(insights.kAnonymousCount(0)).toEqual({ count: null, label: '<5' });
    expect(insights.kAnonymousCount(4)).toEqual({ count: null, label: '<5' });
    expect(insights.kAnonymousCount(5)).toEqual({ count: 5, label: '5' });
  });

  it('builds a 12-month rating trend, oldest first, ignoring older reviews', () => {
    const trend = insights.monthlyRatingTrend([
      { rating: 5, createdAt: new Date('2026-09-02T00:00:00Z') },
      { rating: 2, createdAt: new Date('2026-09-20T00:00:00Z') },
      { rating: 4, createdAt: new Date('2025-10-15T00:00:00Z') },
      { rating: 1, createdAt: new Date('2025-09-30T00:00:00Z') },
    ], NOW);
    expect(trend).toHaveLength(12);
    expect(trend[0]).toEqual({ month: '2025-10', average: 4, count: 1 });
    expect(trend[11]).toEqual({ month: '2026-09', average: 3.5, count: 2 });
    expect(trend[5]).toEqual({ month: '2026-03', average: null, count: 0 });
  });

  it('counts open, non-security reports per listing', () => {
    const counts = insights.openReportCounts(
      [{ id: 'r1', listingId: 'L1' }, { id: 'r2', listingId: 'L2' }],
      [
        { reviewId: 'r1', resolvedAt: null, category: 'spam' },
        { reviewId: 'r1', resolvedAt: new Date(), category: 'abuse' },
        { reviewId: 'r1', resolvedAt: null, category: 'security' },
        { reviewId: 'r2', resolvedAt: null, category: 'abuse' },
        { reviewId: 'zz', resolvedAt: null, category: 'abuse' },
      ],
    );
    expect(Object.fromEntries(counts)).toEqual({ L1: 1, L2: 1 });
  });

  it('returns the caller org\'s own listings only, with installs, adoption, health, trend, reports and advisories', async () => {
    const { acme, official } = seedPublishers(db);
    const { listing } = seedHealthy(acme.id, 'lint');
    const other = seedHealthy(official.id, 'trivy');
    db.seed('plugin_stats', { listingId: listing.id, installCount: 12, activeOrgCount: 3, successRate30d: 0.91234, healthScore: 88, healthBreakdown: { docs: { score: 1, weight: 10 } }, ratingBayes: 4.2, ratingCount: 4 });
    db.seed('plugin_stats', { listingId: other.listing.id, installCount: 99, activeOrgCount: 50 });
    const r1 = db.seed('plugin_reviews', { listingId: listing.id, rating: 4, createdAt: new Date() });
    db.seed('plugin_reviews', { listingId: listing.id, rating: 1, status: 'held', createdAt: new Date() });
    db.seed('plugin_review_reports', { reviewId: r1.id, reporterUserId: 'u-x', category: 'spam' });
    db.seed('plugin_advisories', { listingId: listing.id, publisherId: acme.id, affectedRange: '<2.0.0', severity: 'high', summary: 's', source: 'publisher', createdBy: 'u', state: 'published' });
    db.seed('plugin_advisories', { listingId: listing.id, publisherId: acme.id, affectedRange: '<2.0.0', severity: 'low', summary: 'd', source: 'publisher', createdBy: 'u', state: 'draft' });

    const out = await insights.publisherInsights(tenant() as any);
    expect(out.publisher).toMatchObject({ handle: 'acme' });
    expect(out.listings).toHaveLength(1);
    const [row] = out.listings;
    expect(row).toMatchObject({
      name: 'lint',
      installCount: 12,
      activeOrgs: { count: null, label: '<5' },
      successRate30d: 0.912,
      healthScore: 88,
      healthBreakdown: { docs: { score: 1, weight: 10 } },
      rating: { score: 4.2, count: 4 },
      openReviewReports: 1,
      openAdvisories: 1,
    });
    // Only the published review counts in the trend.
    expect(row!.ratingTrend.reduce((a, p) => a + p.count, 0)).toBe(1);
  });

  it('is empty for an org without a publisher', async () => {
    expect(await insights.publisherInsights(tenant({ orgId: 'org-none' }) as any)).toEqual({ publisher: null, listings: [] });
  });
});
