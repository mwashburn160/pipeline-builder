// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The public directory's query functions over a stubbed reader connection:
 * which views they read, that every caller value is a bound parameter (never
 * spliced into SQL text), and how rows map to the public contract — facets,
 * cursor paging, highlighting, the current version, supply chain and
 * advisories. The SQL itself runs against real Postgres + pgbouncer in the
 * deploy verification.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const executed: Array<{ sql: string; params: unknown[] }> = [];
let responses: unknown[][] = [];
const dialect = new PgDialect();

jest.unstable_mockModule('../src/database/public-reader.js', () => ({
  getPublicReaderDb: () => ({
    execute: async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      executed.push({ sql, params });
      return { rows: responses.shift() ?? [] };
    },
  }),
}));

const {
  searchPublicListings, listPublicCategories, getPublicListing, getPublicListedVersion,
  listPublicListingsForSitemap, listPublicReviews, decodeOffsetCursor, encodeOffsetCursor,
} = await import('../src/api/public-directory.js');

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    publisher_handle: 'acme',
    publisher_display_name: 'Acme',
    publisher_tier: 'community',
    name: 'terraform-plan',
    category: 'iac',
    summary: 'Plan terraform changes',
    description: 'desc',
    readme_html: null,
    license: 'MIT',
    homepage_url: 'https://acme.io',
    source_url: null,
    icon: null,
    uploaded_icon: null,
    keywords: ['terraform'],
    latest_version: '2.0.0',
    updated_at: new Date('2026-09-20T00:00:00Z'),
    rating_bayes: '4.2',
    rating_count: 3,
    rating_dist: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 },
    install_count: 10,
    active_org_count: null,
    state: 'listed',
    ...overrides,
  };
}

beforeEach(() => {
  executed.length = 0;
  responses = [];
});

describe('searchPublicListings', () => {
  it('reads only the public views and binds every caller value as a parameter', async () => {
    const hostile = "x'); DROP TABLE plugins; --";
    await searchPublicListings({ q: hostile, category: hostile, license: hostile, computeType: hostile, tier: 'community' });
    expect(executed).toHaveLength(2);
    for (const { sql, params } of executed) {
      expect(sql).not.toContain('DROP TABLE');
      expect(params).toContain(hostile);
      expect(sql).toMatch(/FROM public_listings l/);
      expect(sql).toMatch(/FROM public_listed_versions pv/);
      expect(sql).not.toMatch(/FROM plugins\b|plugin_listings\b/);
      expect(sql).toContain('l.paused_at IS NULL');
    }
  });

  it('escapes LIKE wildcards in the name match', async () => {
    await searchPublicListings({ q: '100%_done' });
    expect(executed[0].params).toContain('%100\\%\\_done%');
  });

  it('maps rows to cards with highlights, and pages with a cursor while more remain', async () => {
    responses = [
      [{ ...listingRow(), total: 30 }, { ...listingRow({ name: 'other', summary: 'nothing here' }), total: 30 }],
      [],
    ];
    const result = await searchPublicListings({ q: 'terraform', limit: 2 });
    expect(result.total).toBe(30);
    expect(result.items[0]).toMatchObject({ name: 'terraform-plan', rating: { score: 4.2, count: 3 }, installCount: 10 });
    expect(result.items[0].highlight).toEqual({ name: '<mark>terraform</mark>-plan', summary: 'Plan <mark>terraform</mark> changes' });
    expect(result.items[1].highlight).toBeUndefined();
    expect(decodeOffsetCursor(result.nextCursor as string)).toBe(2);
  });

  it('has no next page on the last page, and no highlight without a query', async () => {
    responses = [[{ ...listingRow(), total: 1 }], []];
    const result = await searchPublicListings({});
    expect(result.nextCursor).toBeNull();
    expect(result.items[0].highlight).toBeUndefined();
    // No query → "relevance" falls back to recently updated.
    expect(executed[0].sql).toContain('updated_at DESC');
  });

  it('continues from the cursor offset', async () => {
    responses = [[{ ...listingRow(), total: 3 }], []];
    const result = await searchPublicListings({ cursor: encodeOffsetCursor(2), limit: 1 });
    expect(executed[0].params.slice(-2)).toEqual([1, 2]);
    expect(result.nextCursor).toBeNull();
  });

  it('caps the page size', async () => {
    await searchPublicListings({ limit: 500 });
    expect(executed[0].params.slice(-2)).toEqual([60, 0]);
  });

  it('builds each facet from its own grouping set', async () => {
    responses = [[], [
      { category: 'iac', g_category: 0, g_tier: 1, g_license: 1, g_compute: 1, g_secrets: 1, n: '4' },
      { publisher_tier: 'official', g_category: 1, g_tier: 0, g_license: 1, g_compute: 1, g_secrets: 1, n: 2 },
      { license: 'MIT', g_category: 1, g_tier: 1, g_license: 0, g_compute: 1, g_secrets: 1, n: 3 },
      { compute_type: 'SMALL', g_category: 1, g_tier: 1, g_license: 1, g_compute: 0, g_secrets: 1, n: 5 },
      { needs_secrets: true, g_category: 1, g_tier: 1, g_license: 1, g_compute: 1, g_secrets: 0, n: 1 },
      { needs_secrets: false, g_category: 1, g_tier: 1, g_license: 1, g_compute: 1, g_secrets: 0, n: 6 },
      // A NULL group value (e.g. no license) is not a facet bucket.
      { license: null, g_category: 1, g_tier: 1, g_license: 0, g_compute: 1, g_secrets: 1, n: 9 },
    ]];
    const { facets, total, items } = await searchPublicListings({});
    expect(facets).toEqual({
      category: { iac: 4 },
      tier: { official: 2 },
      license: { MIT: 3 },
      computeType: { SMALL: 5 },
      needsSecrets: { true: 1, false: 6 },
    });
    expect(total).toBe(0);
    expect(items).toEqual([]);
  });

  it.each([
    [{ needsSecrets: true }, '> 0'],
    [{ needsSecrets: false }, '= 0'],
  ])('filters on secrets %p', async (params, op) => {
    await searchPublicListings(params);
    expect(executed[0].sql).toContain(`jsonb_array_length(COALESCE(v.secrets, '[]'::jsonb)) ${op}`);
  });

  it('filters on the minimum rating', async () => {
    await searchPublicListings({ minRating: 4 });
    expect(executed[0].sql).toContain('l.rating_bayes >=');
    expect(executed[0].params).toContain(4);
  });

  it.each(['rating', 'installs', 'name', 'health'] as const)('orders by %s', async (sort) => {
    await searchPublicListings({ sort });
    expect(executed[0].sql).toMatch({
      rating: /rating_bayes DESC/,
      installs: /install_count DESC/,
      name: /name ASC, publisher_handle ASC/,
      health: /health_score DESC NULLS LAST/,
    }[sort]);
  });
});

describe('listPublicCategories', () => {
  it('groups the top listings under each category with its live count', async () => {
    responses = [[
      { ...listingRow({ category: 'iac' }), category_count: '7' },
      { ...listingRow({ category: 'iac', name: 'b' }), category_count: '7' },
      { ...listingRow({ category: 'security', name: 'c' }), category_count: 1 },
    ]];
    const cats = await listPublicCategories(2);
    expect(cats.map((c) => [c.id, c.count, c.top.map((t) => t.name)])).toEqual([
      ['iac', 7, ['terraform-plan', 'b']],
      ['security', 1, ['c']],
    ]);
    expect(executed[0].params).toContain(2);
    expect(executed[0].sql).toContain('FROM public_listings l');
  });

  it('bounds how many top listings a caller can ask for', async () => {
    await listPublicCategories(1000);
    expect(executed[0].params).toContain(10);
  });
});

describe('getPublicListing', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const version = (v: string, extra: Record<string, unknown> = {}) => ({
    version: v,
    published_at: '2026-09-01T00:00:00Z',
    breaking: false,
    deprecated_at: null,
    deprecation_message: null,
    yanked: false,
    changelog: null,
    vuln_critical: 0,
    vuln_high: 1,
    scanned_at: '2026-09-02T00:00:00Z',
    image_digest: DIGEST,
    image_source: 'built',
    plugin_type: 'CodeBuildStep',
    compute_type: 'SMALL',
    secrets: [{ name: 'TOKEN', required: true }],
    required_metadata: ['env'],
    required_vars: [],
    network_egress: ['api.acme.io'],
    readme_html: '<p>version readme</p>',
    ...extra,
  });

  it('returns null for a listing that is not public, without reading versions', async () => {
    responses = [[]];
    expect(await getPublicListing('acme', 'nope')).toBeNull();
    expect(executed).toHaveLength(1);
    expect(executed[0].params).toEqual(['acme', 'nope']);
  });

  it('describes the latest version: config, supply chain and SBOM link; versions newest first', async () => {
    responses = [
      [listingRow()],
      [version('1.10.0'), version('2.0.0', { deprecated_at: '2026-09-10', deprecation_message: 'use 3' }), version('1.9.0', { yanked: true })],
      [{
        id: 'a1',
        severity: 'high',
        summary: 'bad',
        affected_range: '<2.0.0',
        fixed_version: '2.0.0',
        published_at: '2026-09-05T00:00:00Z',
        details_html: '<p>details</p>',
        cve_ids: ['CVE-2026-0001'],
      }],
    ];
    const detail = await getPublicListing('acme', 'terraform-plan');
    expect(detail?.versions.map((v) => v.version)).toEqual(['2.0.0', '1.10.0', '1.9.0']);
    expect(detail?.versions[0]).toMatchObject({ deprecated: true, deprecationMessage: 'use 3' });
    expect(detail?.versions[2].yanked).toBe(true);
    expect(detail?.configuration).toEqual({
      secrets: [{ name: 'TOKEN', required: true, description: '' }],
      requiredMetadata: ['env'],
      requiredVars: [],
      computeType: 'SMALL',
      primaryOutputDirectory: null,
      networkEgress: ['api.acme.io'],
      pluginType: 'CodeBuildStep',
    });
    expect(detail?.supplyChain).toMatchObject({
      signed: true,
      digest: DIGEST,
      imageSource: 'built',
      sbomUrl: '/api/public/plugins/acme/terraform-plan/versions/2.0.0/sbom',
    });
    expect(detail?.readmeHtml).toBe('<p>version readme</p>');
    expect(detail?.advisories).toEqual([{
      id: 'a1',
      severity: 'high',
      summary: 'bad',
      affectedRange: '<2.0.0',
      fixedVersion: '2.0.0',
      publishedAt: '2026-09-05T00:00:00.000Z',
      detailsHtml: '<p>details</p>',
      cveIds: ['CVE-2026-0001'],
    }]);
    // Each version carries the advisories whose range covers it.
    expect(detail?.versions.map((v) => v.advisoryIds)).toEqual([[], ['a1'], ['a1']]);
    expect(detail?.ratingDistribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 });
    expect(detail?.recentRating).toBeNull();
    expect(detail?.activeOrgCount).toBeNull();
    for (const q of executed) expect(q.sql).toMatch(/public_(listings|listed_versions|advisories)/);
  });

  it('falls back to the newest non-yanked version when the latest is yanked', async () => {
    responses = [[listingRow()], [version('2.0.0', { yanked: true }), version('1.5.0')], []];
    const detail = await getPublicListing('acme', 'terraform-plan');
    expect(detail?.supplyChain.sbomUrl).toContain('/versions/1.5.0/sbom');
  });

  it('reports an unsigned, empty configuration when every version is yanked', async () => {
    responses = [[listingRow({ rating_dist: null, active_org_count: '12', recent_rating: '3.456' })], [version('2.0.0', { yanked: true })], []];
    const detail = await getPublicListing('acme', 'terraform-plan');
    expect(detail?.supplyChain).toMatchObject({ signed: false, digest: null, sbomUrl: null });
    expect(detail?.configuration.secrets).toEqual([]);
    expect(detail?.ratingDistribution).toBeNull();
    expect(detail?.activeOrgCount).toBe(12);
    expect(detail?.recentRating).toBe(3.46);
  });

  it('carries the health score, its breakdown and the 30-day success rate (W7)', async () => {
    const breakdown = { runtime: { score: 0.9, weight: 25 }, rating: { score: null, weight: 10 } };
    responses = [[listingRow({ health_score: 88, health_breakdown: breakdown, success_rate_30d: '0.91234' })], [version('1.10.0')], []];
    const detail = await getPublicListing('acme', 'terraform-plan');
    expect(detail?.healthScore).toBe(88);
    expect(detail?.healthBreakdown).toEqual(breakdown);
    expect(detail?.successRate30d).toBe(0.912);
  });
});

describe('getPublicListedVersion + sitemap', () => {
  it('returns the public image of a listed, non-yanked version', async () => {
    responses = [[{ image_repository: 'public/acme/x', image_digest: 'sha256:1' }]];
    expect(await getPublicListedVersion('acme', 'x', '1.0.0')).toEqual({ imageRepository: 'public/acme/x', imageDigest: 'sha256:1' });
    expect(executed[0].sql).toContain('NOT yanked');
    expect(executed[0].params.slice(0, 3)).toEqual(['acme', 'x', '1.0.0']);
  });

  it('returns null when there is no such version or no image', async () => {
    responses = [[], [{ image_repository: null, image_digest: 'sha256:1' }]];
    expect(await getPublicListedVersion('acme', 'x', '9.9.9')).toBeNull();
    expect(await getPublicListedVersion('acme', 'x', '1.0.0')).toBeNull();
  });

  it('lists sitemap entries with a bounded row count', async () => {
    responses = [[{ publisher_handle: 'acme', name: 'x', updated_at: '2026-09-20T00:00:00Z' }]];
    expect(await listPublicListingsForSitemap(10_000_000)).toEqual([{ publisher: 'acme', name: 'x', updatedAt: '2026-09-20T00:00:00.000Z' }]);
    expect(executed[0].params).toContain(50_000);
  });
});

describe('listPublicReviews', () => {
  const review = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    version: '2.0.0',
    rating: 4,
    title: 'Solid',
    body_html: '<p>works</p>',
    author_display_name: 'alice',
    verified_use: true,
    helpful_count: '3',
    edited: false,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-11T00:00:00Z',
    publisher_display_name: 'Acme',
    reply_body_html: null,
    reply_created_at: null,
    reply_updated_at: null,
    total: '3',
    ...extra,
  });

  it('returns null for a listing that is not public, without reading reviews', async () => {
    responses = [[]];
    expect(await listPublicReviews('acme', 'nope')).toBeNull();
    expect(executed).toHaveLength(1);
    expect(executed[0].sql).toMatch(/FROM public_listings/);
  });

  it('reads only public_reviews, binds every value, and maps rows to the public contract', async () => {
    responses = [[{ id: 'l1' }], [
      review('r1'),
      review('r2', {
        author_display_name: null,
        verified_use: false,
        edited: true,
        reply_body_html: '<p>thanks</p>',
        reply_created_at: '2026-09-12T00:00:00Z',
        reply_updated_at: '2026-09-12T00:00:00Z',
      }),
    ]];
    const page = await listPublicReviews('acme', 'terraform-plan', { sort: 'recent', rating: 4, limit: 2 });
    expect(executed[1].sql).toMatch(/FROM public_reviews/);
    expect(executed[1].sql).not.toMatch(/plugin_reviews|author_user_id|author_org_id/);
    expect(executed[1].sql).toMatch(/ORDER BY created_at DESC/);
    expect(executed[1].params).toEqual(expect.arrayContaining(['l1', 4, 2, 0]));
    expect(page).toEqual({
      total: 3,
      nextCursor: encodeOffsetCursor(2),
      reviews: [
        {
          id: 'r1',
          rating: 4,
          title: 'Solid',
          bodyHtml: '<p>works</p>',
          version: '2.0.0',
          author: { displayName: 'alice' },
          verifiedUse: true,
          helpfulCount: 3,
          edited: false,
          createdAt: '2026-09-10T00:00:00.000Z',
          updatedAt: '2026-09-11T00:00:00.000Z',
          reply: null,
        },
        expect.objectContaining({
          id: 'r2',
          author: null,
          verifiedUse: false,
          edited: true,
          reply: { bodyHtml: '<p>thanks</p>', publisherDisplayName: 'Acme', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' },
        }),
      ],
    });
  });

  it.each([
    ['helpful', /ORDER BY helpful_count DESC, verified_use DESC/],
    ['highest', /ORDER BY rating DESC/],
    ['lowest', /ORDER BY rating ASC/],
    ['bogus', /ORDER BY helpful_count DESC/],
  ])('sorts by %s', async (sort, re) => {
    responses = [[{ id: 'l1' }], []];
    const page = await listPublicReviews('acme', 'x', { sort: sort as never });
    expect(executed[1].sql).toMatch(re);
    expect(page).toEqual({ reviews: [], total: 0, nextCursor: null });
  });

  it('ignores an out-of-range star filter, caps the page size and continues from the cursor', async () => {
    responses = [[{ id: 'l1' }], [review('r3')]];
    const page = await listPublicReviews('acme', 'x', { rating: 9, limit: 500, cursor: encodeOffsetCursor(2) });
    expect(executed[1].sql).not.toMatch(/rating = /);
    expect(executed[1].params).toEqual(['l1', 50, 2]);
    expect(page!.nextCursor).toBeNull();
    responses = [[{ id: 'l1' }], []];
    await listPublicReviews('acme', 'x', { limit: Number.NaN });
    expect(executed[3].params).toEqual(['l1', 10, 0]);
  });
});
