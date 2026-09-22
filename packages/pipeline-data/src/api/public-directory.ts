// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Queries behind the anonymous public plugin directory
 * (docs/plugin-publishing.md).
 *
 * Every query here reads ONLY the `public_listings`, `public_listed_versions`,
 * `public_advisories` and `public_reviews` views, through the `ecosystem_public_reader`
 * connection ({@link getPublicReaderDb}). Those views already filter to public
 * rows (listed/unmaintained listings of non-suspended publishers, non-paused
 * versions, published advisories) and project public columns only, so nothing
 * here needs — or has — a tenant context.
 *
 * Search: Postgres full-text (`search_vector`, weighted name A / keywords and
 * category B / summary C / README D, `english` config) OR a trigram match on the
 * name (typo tolerance), ranked by `ts_rank` + name similarity, blended with the
 * Bayesian rating and install count when present. Paused listings are hidden.
 */

import { sql, type SQL } from 'drizzle-orm';

import { advisoryRangeCovers } from './plugin-resolution.js';
import { compareSemver } from './semver-range.js';
import { resultRows } from '../database/pg-result.js';
import { getPublicReaderDb } from '../database/public-reader.js';

// -----------------------------------------------------------------------------
// Public contract (mirrors frontend/src/lib/public-directory/types.ts)
// -----------------------------------------------------------------------------

export type DirectoryTrustTier = 'official' | 'verified' | 'community' | 'unverified';
export type DirectoryIconKind = 'vendor' | 'uploaded' | 'monogram' | 'category';
export type DirectorySort = 'relevance' | 'rating' | 'installs' | 'updated' | 'name' | 'health';

export const DIRECTORY_SORTS: readonly DirectorySort[] = ['relevance', 'rating', 'installs', 'updated', 'name', 'health'];

/** Per-component health scores: `{ score: 0..1 | null (missing), weight }`. */
export type DirectoryHealthBreakdown = Record<string, { score: number | null; weight: number }>;
export const DIRECTORY_TIERS: readonly DirectoryTrustTier[] = ['official', 'verified', 'community', 'unverified'];

/** Minimum `word_similarity(query, name)` for a fuzzy name match (typo tolerance). */
export const FUZZY_NAME_THRESHOLD = 0.3;

/** Max query length accepted (longer is truncated, never an error). */
export const DIRECTORY_MAX_QUERY_LENGTH = 100;
export const DIRECTORY_DEFAULT_LIMIT = 24;
export const DIRECTORY_MAX_LIMIT = 60;

export interface DirectorySearchParams {
  q?: string;
  category?: string;
  tier?: DirectoryTrustTier;
  license?: string;
  computeType?: string;
  needsSecrets?: boolean;
  minRating?: number;
  sort?: DirectorySort;
  cursor?: string;
  limit?: number;
}

export interface DirectoryListingCard {
  publisher: { handle: string; displayName: string; tier: DirectoryTrustTier };
  name: string;
  summary: string;
  category: string;
  keywords: string[];
  latestVersion: string;
  license: string;
  iconUrl: string | null;
  iconKind: DirectoryIconKind;
  iconKey: string | null;
  iconHex: string | null;
  iconBadge: string | null;
  rating: { score: number; count: number } | null;
  installCount: number;
  /** 0–100 health score; null when fewer than three components are known. */
  healthScore: number | null;
  updatedAt: string;
  state: 'listed' | 'unmaintained';
  highlight?: { name?: string; summary?: string };
}

export interface DirectorySearchResult {
  items: DirectoryListingCard[];
  facets: {
    category: Record<string, number>;
    tier: Record<string, number>;
    license: Record<string, number>;
    computeType: Record<string, number>;
    needsSecrets: { true: number; false: number };
  };
  total: number;
  nextCursor: string | null;
}

export interface DirectoryCategorySummary {
  id: string;
  count: number;
  top: DirectoryListingCard[];
}

export interface DirectoryListingVersion {
  version: string;
  publishedAt: string;
  breaking: boolean;
  deprecated: boolean;
  deprecationMessage: string | null;
  yanked: boolean;
  changelog: string | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  /** Of those, the findings grype reports a fixed version for. */
  vulnCriticalFixable: number | null;
  vulnHighFixable: number | null;
  scannedAt: string | null;
  /** When the nightly rescan flagged this version (fixable criticals over the platform floor); null = not flagged. */
  scanFlaggedAt: string | null;
  /** Ids of the published advisories whose range covers this version. */
  advisoryIds: string[];
}

export interface DirectoryListingDetail extends DirectoryListingCard {
  readmeHtml: string | null;
  description: string;
  homepageUrl: string | null;
  sourceUrl: string | null;
  versions: DirectoryListingVersion[];
  configuration: {
    secrets: { name: string; required: boolean; description: string }[];
    requiredMetadata: string[];
    requiredVars: string[];
    computeType: string;
    primaryOutputDirectory: string | null;
    networkEgress: string[];
    pluginType: string;
  };
  supplyChain: {
    signed: boolean;
    digest: string | null;
    imageSource: string | null;
    scannedAt: string | null;
    vulnCritical: number | null;
    vulnHigh: number | null;
    vulnCriticalFixable: number | null;
    vulnHighFixable: number | null;
    scanFlaggedAt: string | null;
    sbomUrl: string | null;
  };
  advisories: {
    id: string;
    severity: string;
    summary: string;
    affectedRange: string;
    fixedVersion: string | null;
    publishedAt: string;
    /** Server-sanitized HTML (the stored render of the details markdown). */
    detailsHtml: string | null;
    cveIds: string[];
  }[];
  ratingDistribution: Record<'1' | '2' | '3' | '4' | '5', number> | null;
  /** The Bayesian rating over reviews of the last two minor versions. */
  recentRating: number | null;
  activeOrgCount: number | null;
  /** Per-component health scores behind {@link DirectoryListingCard.healthScore}. */
  healthBreakdown: DirectoryHealthBreakdown | null;
  /** 30-day runtime success rate (0..1), or null with no runs. */
  successRate30d: number | null;
}

export type ReviewSort = 'helpful' | 'recent' | 'highest' | 'lowest';
export const REVIEW_SORTS: readonly ReviewSort[] = ['helpful', 'recent', 'highest', 'lowest'];
export const REVIEWS_DEFAULT_LIMIT = 10;
export const REVIEWS_MAX_LIMIT = 50;

export interface PublicReviewReply {
  bodyHtml: string;
  publisherDisplayName: string;
  createdAt: string;
  updatedAt: string;
}

/** One published review as the directory shows it: display name only, never an org. */
export interface PublicReviewItem {
  id: string;
  rating: number;
  title: string | null;
  bodyHtml: string | null;
  version: string | null;
  /** Null once the author's account was deleted (the review is anonymized). */
  author: { displayName: string } | null;
  verifiedUse: boolean;
  helpfulCount: number;
  edited: boolean;
  createdAt: string;
  updatedAt: string;
  reply: PublicReviewReply | null;
}

export interface PublicReviewPage {
  reviews: PublicReviewItem[];
  total: number;
  nextCursor: string | null;
}

export interface PublicReviewQuery {
  sort?: ReviewSort;
  /** Only reviews with exactly this many stars. */
  rating?: number;
  cursor?: string;
  limit?: number;
}

// -----------------------------------------------------------------------------
// Row mapping
// -----------------------------------------------------------------------------

/** A `public_listings` row as the raw queries return it (snake_case). */
export interface PublicListingRow {
  id: string;
  publisher_handle: string;
  publisher_display_name: string;
  publisher_tier: DirectoryTrustTier;
  name: string;
  category: string;
  summary: string | null;
  description: string | null;
  readme_html: string | null;
  license: string | null;
  homepage_url: string | null;
  source_url: string | null;
  icon: { key: string; badge?: string } | null;
  uploaded_icon: { key256: string; key64: string } | null;
  keywords: string[] | null;
  latest_version: string | null;
  updated_at: Date | string;
  rating_bayes: number | string | null;
  rating_count: number | string;
  rating_dist: Record<string, number> | null;
  recent_rating?: number | string | null;
  install_count: number | string;
  active_org_count: number | string | null;
  health_score?: number | string | null;
  health_breakdown?: DirectoryHealthBreakdown | null;
  success_rate_30d?: number | string | null;
  state: 'listed' | 'unmaintained';
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

function iso(v: Date | string | null | undefined): string {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * The icon fallback chain: uploaded (if the tier may upload) → curated
 * vendor key (Official, and Verified publishers for marks they own — ownership
 * is checked when the icon is approved) → monogram. Community and anonymous
 * listings can never show a curated vendor mark.
 */
export function resolveListingIcon(row: Pick<PublicListingRow, 'publisher_tier' | 'icon' | 'uploaded_icon'>): Pick<
  DirectoryListingCard, 'iconKind' | 'iconUrl' | 'iconKey' | 'iconBadge' | 'iconHex'
> {
  const none = { iconUrl: null, iconKey: null, iconBadge: null, iconHex: null };
  if (row.uploaded_icon?.key256) {
    return { ...none, iconKind: 'uploaded', iconUrl: `/api/public/plugins/icons/${encodeURIComponent(row.uploaded_icon.key256)}` };
  }
  const curatedAllowed = row.publisher_tier === 'official' || row.publisher_tier === 'verified';
  if (curatedAllowed && row.icon?.key) {
    return { ...none, iconKind: 'vendor', iconKey: row.icon.key, iconBadge: row.icon.badge ?? null };
  }
  return { ...none, iconKind: 'monogram' };
}

export function toListingCard(row: PublicListingRow): DirectoryListingCard {
  const ratingCount = num(row.rating_count);
  return {
    publisher: { handle: row.publisher_handle, displayName: row.publisher_display_name, tier: row.publisher_tier },
    name: row.name,
    summary: row.summary ?? '',
    category: row.category,
    keywords: row.keywords ?? [],
    latestVersion: row.latest_version ?? '',
    license: row.license ?? '',
    ...resolveListingIcon(row),
    rating: ratingCount > 0 && row.rating_bayes != null ? { score: Math.round(num(row.rating_bayes) * 100) / 100, count: ratingCount } : null,
    installCount: num(row.install_count),
    healthScore: row.health_score == null ? null : Math.round(num(row.health_score)),
    updatedAt: iso(row.updated_at),
    state: row.state,
  };
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

/** Normalize the user's query: collapse whitespace, cap the length. */
export function normalizeQuery(q: string | undefined): string {
  return (q ?? '').replace(/\s+/g, ' ').trim().slice(0, DIRECTORY_MAX_QUERY_LENGTH);
}

/** Search terms for highlighting: words of ≥ 2 characters, regex-escaped. */
function highlightTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9._-]+/).filter((t) => t.length >= 2))]
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Wrap matched terms in `<mark>`. The frontend renders everything except the
 * `<mark>` markers as TEXT (never HTML), so the source text is not escaped here.
 * Returns undefined when nothing matched (the card then renders plain text).
 */
export function highlightText(text: string, q: string): string | undefined {
  const terms = highlightTerms(q);
  if (!text || terms.length === 0) return undefined;
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  if (!re.test(text)) return undefined;
  return text.replace(re, '<mark>$1</mark>');
}

/** Opaque cursor: an offset, base64url-encoded so clients don't depend on it. */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }).o;
    return typeof o === 'number' && Number.isInteger(o) && o >= 0 && o <= 10_000 ? o : 0;
  } catch {
    return 0;
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DIRECTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), DIRECTORY_MAX_LIMIT);
}

/**
 * The filtered base set as a CTE body. Every search, facet and category query
 * reads through this, so they can't disagree about what's visible.
 */
function baseQuery(params: DirectorySearchParams, q: string): SQL {
  const where: SQL[] = [sql`l.paused_at IS NULL`];
  if (q) {
    // Full text, OR a fuzzy match against the best-matching PART of the name
    // (word_similarity: "terafrom" → terraform-plan scores 0.36, while unrelated
    // words stay ≤ 0.2 — whole-name similarity() dilutes a long name below any
    // useful threshold). Explicit function, not the `<%` operator, so the cut-off
    // doesn't depend on a session GUC pgbouncer can't carry. A seq scan over the
    // public listings (thousands of rows at most) is fine.
    where.push(sql`(l.search_vector @@ websearch_to_tsquery('english', ${q}) OR word_similarity(${q}, l.name) >= ${FUZZY_NAME_THRESHOLD} OR l.name ILIKE ${`%${q.replace(/[\\%_]/g, '\\$&')}%`})`);
  }
  if (params.category) where.push(sql`l.category = ${params.category}`);
  if (params.tier) where.push(sql`l.publisher_tier = ${params.tier}`);
  if (params.license) where.push(sql`l.license = ${params.license}`);
  if (params.computeType) where.push(sql`v.compute_type = ${params.computeType}`);
  if (params.needsSecrets !== undefined) {
    where.push(params.needsSecrets
      ? sql`jsonb_array_length(COALESCE(v.secrets, '[]'::jsonb)) > 0`
      : sql`jsonb_array_length(COALESCE(v.secrets, '[]'::jsonb)) = 0`);
  }
  if (params.minRating !== undefined && Number.isFinite(params.minRating)) {
    where.push(sql`l.rating_bayes >= ${params.minRating}`);
  }
  const rank = q
    ? sql`(ts_rank(l.search_vector, websearch_to_tsquery('english', ${q})) + word_similarity(${q}, l.name))`
    : sql`0::real`;
  return sql`
    SELECT l.id, l.publisher_handle, l.publisher_display_name, l.publisher_tier, l.name, l.category,
           l.summary, l.description, l.readme_html, l.license, l.homepage_url, l.source_url, l.icon,
           l.uploaded_icon, l.keywords, l.latest_version, l.updated_at, l.rating_bayes, l.rating_count,
           l.rating_dist, l.install_count, l.active_org_count, l.health_score, l.state,
           v.compute_type,
           (jsonb_array_length(COALESCE(v.secrets, '[]'::jsonb)) > 0) AS needs_secrets,
           ${rank} AS rank
      FROM public_listings l
      LEFT JOIN LATERAL (
        SELECT pv.compute_type, pv.secrets
          FROM public_listed_versions pv
         WHERE pv.listing_id = l.id AND pv.version = l.latest_version AND NOT pv.yanked
         LIMIT 1
      ) v ON true
     WHERE ${sql.join(where, sql` AND `)}`;
}

function orderBy(sort: DirectorySort, hasQuery: boolean): SQL {
  switch (sort === 'relevance' && !hasQuery ? 'updated' : sort) {
    case 'relevance':
      // Text relevance first, nudged by rating and adoption so equal matches
      // favour proven plugins.
      return sql`(rank * (1 + COALESCE(rating_bayes, 0) / 10) + ln(1 + install_count) / 20) DESC, name ASC`;
    case 'rating':
      return sql`rating_bayes DESC NULLS LAST, rating_count DESC, name ASC`;
    case 'installs':
      return sql`install_count DESC, name ASC`;
    case 'name':
      return sql`name ASC, publisher_handle ASC`;
    case 'health':
      return sql`health_score DESC NULLS LAST, install_count DESC, name ASC`;
    case 'updated':
    default:
      return sql`updated_at DESC, name ASC`;
  }
}

/** Search the directory: one page of cards, facet counts, total and next cursor. */
export async function searchPublicListings(params: DirectorySearchParams): Promise<DirectorySearchResult> {
  const db = getPublicReaderDb();
  const q = normalizeQuery(params.q);
  const limit = clampLimit(params.limit);
  const offset = decodeOffsetCursor(params.cursor);
  const sort = params.sort && DIRECTORY_SORTS.includes(params.sort) ? params.sort : 'relevance';
  const base = baseQuery(params, q);

  const [pageRes, facetRes] = await Promise.all([
    db.execute(sql`
      WITH base AS (${base})
      SELECT base.*, COUNT(*) OVER () AS total
        FROM base
       ORDER BY ${orderBy(sort, q !== '')}
       LIMIT ${limit} OFFSET ${offset}`),
    db.execute(sql`
      WITH base AS (${base})
      SELECT category, publisher_tier, license, compute_type, needs_secrets,
             GROUPING(category) AS g_category, GROUPING(publisher_tier) AS g_tier,
             GROUPING(license) AS g_license, GROUPING(compute_type) AS g_compute,
             GROUPING(needs_secrets) AS g_secrets,
             COUNT(*) AS n
        FROM base
       GROUP BY GROUPING SETS ((category), (publisher_tier), (license), (compute_type), (needs_secrets))`),
  ]);

  const page = resultRows<PublicListingRow & { total: number | string }>(pageRes);
  const total = page.length > 0 ? num(page[0]!.total) : 0;
  const items = page.map((row) => {
    const card = toListingCard(row);
    if (q) {
      const highlight = { name: highlightText(card.name, q), summary: highlightText(card.summary, q) };
      if (highlight.name || highlight.summary) card.highlight = highlight;
    }
    return card;
  });

  const facets: DirectorySearchResult['facets'] = {
    category: {}, tier: {}, license: {}, computeType: {}, needsSecrets: { true: 0, false: 0 },
  };
  type FacetRow = {
    category: string | null;
    publisher_tier: string | null;
    license: string | null;
    compute_type: string | null;
    needs_secrets: boolean | null;
    g_category: number;
    g_tier: number;
    g_license: number;
    g_compute: number;
    g_secrets: number;
    n: number | string;
  };
  for (const r of resultRows<FacetRow>(facetRes)) {
    const n = num(r.n);
    if (Number(r.g_category) === 0 && r.category) facets.category[r.category] = n;
    else if (Number(r.g_tier) === 0 && r.publisher_tier) facets.tier[r.publisher_tier] = n;
    else if (Number(r.g_license) === 0 && r.license) facets.license[r.license] = n;
    else if (Number(r.g_compute) === 0 && r.compute_type) facets.computeType[r.compute_type] = n;
    else if (Number(r.g_secrets) === 0 && r.needs_secrets !== null) facets.needsSecrets[r.needs_secrets ? 'true' : 'false'] = n;
  }

  return {
    items,
    facets,
    total,
    nextCursor: offset + items.length < total ? encodeOffsetCursor(offset + items.length) : null,
  };
}

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------

/** Every category with its live count and its top listings (by rating, then installs). */
export async function listPublicCategories(topPerCategory = 3): Promise<DirectoryCategorySummary[]> {
  const db = getPublicReaderDb();
  const res = await db.execute(sql`
    WITH ranked AS (
      SELECT l.*,
             ROW_NUMBER() OVER (PARTITION BY l.category
                                ORDER BY l.rating_bayes DESC NULLS LAST, l.install_count DESC, l.name ASC) AS rn,
             COUNT(*) OVER (PARTITION BY l.category) AS category_count
        FROM public_listings l
       WHERE l.paused_at IS NULL
    )
    SELECT * FROM ranked WHERE rn <= ${Math.max(0, Math.min(topPerCategory, 10))} ORDER BY category ASC, rn ASC`);

  const byCategory = new Map<string, DirectoryCategorySummary>();
  for (const row of resultRows<PublicListingRow & { category_count: number | string }>(res)) {
    let summary = byCategory.get(row.category);
    if (!summary) {
      summary = { id: row.category, count: num(row.category_count), top: [] };
      byCategory.set(row.category, summary);
    }
    summary.top.push(toListingCard(row));
  }
  return [...byCategory.values()];
}

// -----------------------------------------------------------------------------
// One listing
// -----------------------------------------------------------------------------

type VersionRow = {
  version: string;
  published_at: Date | string;
  breaking: boolean;
  deprecated_at: Date | string | null;
  deprecation_message: string | null;
  yanked: boolean;
  changelog: string | null;
  vuln_critical: number | null;
  vuln_high: number | null;
  vuln_critical_fixable: number | null;
  vuln_high_fixable: number | null;
  scanned_at: Date | string | null;
  scan_flagged_at: Date | string | null;
  image_digest: string | null;
  image_source: string | null;
  plugin_type: string | null;
  compute_type: string | null;
  secrets: { name: string; required: boolean; description?: string }[] | null;
  required_metadata: string[] | null;
  required_vars: string[] | null;
  network_egress: string[] | null;
  readme_html: string | null;
};

type AdvisoryRow = {
  id: string;
  severity: string;
  summary: string;
  affected_range: string;
  fixed_version: string | null;
  published_at: Date | string | null;
  details_html: string | null;
  cve_ids: string[] | null;
};

/**
 * One listing's page data, or null when it isn't public (unknown, suspended,
 * transferred, paused by its publisher — or its publisher is suspended).
 */
export async function getPublicListing(publisherHandle: string, name: string): Promise<DirectoryListingDetail | null> {
  const db = getPublicReaderDb();
  const listingRes = await db.execute(sql`
    SELECT * FROM public_listings
     WHERE publisher_handle = ${publisherHandle} AND name = ${name} AND paused_at IS NULL
     LIMIT 1`);
  const row = resultRows<PublicListingRow>(listingRes)[0];
  if (!row) return null;

  const [versionRes, advisoryRes] = await Promise.all([
    db.execute(sql`SELECT * FROM public_listed_versions WHERE listing_id = ${row.id}`),
    db.execute(sql`SELECT * FROM public_advisories WHERE listing_id = ${row.id} ORDER BY published_at DESC`),
  ]);
  const versionRows = resultRows<VersionRow>(versionRes).sort((a, b) => compareSemver(b.version, a.version));
  const advisoryRows = resultRows<AdvisoryRow>(advisoryRes);
  // The version the page describes: the listing's latest, else the newest non-yanked one.
  const current = versionRows.find((v) => v.version === row.latest_version && !v.yanked)
    ?? versionRows.find((v) => !v.yanked)
    ?? null;

  const dist = row.rating_dist ?? null;
  const card = toListingCard(row);
  return {
    ...card,
    readmeHtml: row.readme_html ?? current?.readme_html ?? null,
    description: row.description ?? '',
    homepageUrl: row.homepage_url,
    sourceUrl: row.source_url,
    versions: versionRows.map((v) => ({
      version: v.version,
      publishedAt: iso(v.published_at),
      breaking: v.breaking,
      deprecated: v.deprecated_at != null,
      deprecationMessage: v.deprecation_message,
      yanked: v.yanked,
      changelog: v.changelog,
      vulnCritical: v.vuln_critical,
      vulnHigh: v.vuln_high,
      vulnCriticalFixable: v.vuln_critical_fixable ?? null,
      vulnHighFixable: v.vuln_high_fixable ?? null,
      scannedAt: v.scanned_at ? iso(v.scanned_at) : null,
      scanFlaggedAt: v.scan_flagged_at ? iso(v.scan_flagged_at) : null,
      advisoryIds: advisoryRows.filter((a) => advisoryRangeCovers(a.affected_range, v.version)).map((a) => a.id),
    })),
    configuration: {
      secrets: (current?.secrets ?? []).map((s) => ({ name: s.name, required: s.required, description: s.description ?? '' })),
      requiredMetadata: current?.required_metadata ?? [],
      requiredVars: current?.required_vars ?? [],
      computeType: current?.compute_type ?? '',
      primaryOutputDirectory: null,
      networkEgress: current?.network_egress ?? [],
      pluginType: current?.plugin_type ?? '',
    },
    supplyChain: {
      // A listed version exists only after the platform re-signed it in public/*.
      signed: current?.image_digest != null,
      digest: current?.image_digest ?? null,
      imageSource: current?.image_source ?? null,
      scannedAt: current?.scanned_at ? iso(current.scanned_at) : null,
      vulnCritical: current?.vuln_critical ?? null,
      vulnHigh: current?.vuln_high ?? null,
      vulnCriticalFixable: current?.vuln_critical_fixable ?? null,
      vulnHighFixable: current?.vuln_high_fixable ?? null,
      scanFlaggedAt: current?.scan_flagged_at ? iso(current.scan_flagged_at) : null,
      sbomUrl: current?.image_digest
        ? `/api/public/plugins/${encodeURIComponent(row.publisher_handle)}/${encodeURIComponent(row.name)}/versions/${encodeURIComponent(current.version)}/sbom`
        : null,
    },
    advisories: advisoryRows.map((a) => ({
      id: a.id,
      severity: a.severity,
      summary: a.summary,
      affectedRange: a.affected_range,
      fixedVersion: a.fixed_version,
      publishedAt: iso(a.published_at),
      detailsHtml: a.details_html,
      cveIds: a.cve_ids ?? [],
    })),
    ratingDistribution: dist
      ? { 1: num(dist['1']), 2: num(dist['2']), 3: num(dist['3']), 4: num(dist['4']), 5: num(dist['5']) }
      : null,
    recentRating: row.recent_rating == null ? null : Math.round(num(row.recent_rating) * 100) / 100,
    activeOrgCount: row.active_org_count == null ? null : num(row.active_org_count),
    healthBreakdown: row.health_breakdown ?? null,
    successRate30d: row.success_rate_30d == null ? null : Math.round(num(row.success_rate_30d) * 1000) / 1000,
  };
}

/** One listed version's public image identity (for the SBOM download), or null. */
export async function getPublicListedVersion(
  publisherHandle: string, name: string, version: string,
): Promise<{ imageRepository: string; imageDigest: string } | null> {
  const db = getPublicReaderDb();
  const res = await db.execute(sql`
    SELECT image_repository, image_digest FROM public_listed_versions
     WHERE publisher_handle = ${publisherHandle} AND name = ${name} AND version = ${version} AND NOT yanked
       AND listing_id IN (SELECT id FROM public_listings WHERE paused_at IS NULL)
     LIMIT 1`);
  const row = resultRows<{ image_repository: string | null; image_digest: string | null }>(res)[0];
  if (!row?.image_repository || !row.image_digest) return null;
  return { imageRepository: row.image_repository, imageDigest: row.image_digest };
}

// -----------------------------------------------------------------------------
// Reviews
// -----------------------------------------------------------------------------

type ReviewRow = {
  id: string;
  version: string | null;
  rating: number | string;
  title: string | null;
  body_html: string | null;
  author_display_name: string | null;
  verified_use: boolean;
  helpful_count: number | string;
  edited: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  publisher_display_name: string;
  reply_body_html: string | null;
  reply_created_at: Date | string | null;
  reply_updated_at: Date | string | null;
  total: number | string;
};

function reviewOrder(sort: ReviewSort): SQL {
  switch (sort) {
    case 'recent': return sql`created_at DESC, id ASC`;
    case 'highest': return sql`rating DESC, helpful_count DESC, created_at DESC, id ASC`;
    case 'lowest': return sql`rating ASC, helpful_count DESC, created_at DESC, id ASC`;
    case 'helpful':
    default:
      // Verified use breaks ties: an org that runs the plugin knows it best.
      return sql`helpful_count DESC, verified_use DESC, created_at DESC, id ASC`;
  }
}

export function toPublicReview(row: Omit<ReviewRow, 'total'>): PublicReviewItem {
  return {
    id: row.id,
    rating: num(row.rating),
    title: row.title,
    bodyHtml: row.body_html,
    version: row.version,
    author: row.author_display_name ? { displayName: row.author_display_name } : null,
    verifiedUse: row.verified_use === true,
    helpfulCount: num(row.helpful_count),
    edited: row.edited === true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    reply: row.reply_body_html
      ? {
        bodyHtml: row.reply_body_html,
        publisherDisplayName: row.publisher_display_name,
        createdAt: iso(row.reply_created_at),
        updatedAt: iso(row.reply_updated_at),
      }
      : null,
  };
}

/**
 * One page of a listing's published reviews (the directory's Reviews tab), or null
 * when the listing isn't public. Held and removed reviews never reach the view.
 */
export async function listPublicReviews(publisherHandle: string, name: string, query: PublicReviewQuery = {}): Promise<PublicReviewPage | null> {
  const db = getPublicReaderDb();
  const listing = resultRows<{ id: string }>(await db.execute(sql`
    SELECT id FROM public_listings
     WHERE publisher_handle = ${publisherHandle} AND name = ${name} AND paused_at IS NULL
     LIMIT 1`))[0];
  if (!listing) return null;

  const sort = query.sort && REVIEW_SORTS.includes(query.sort) ? query.sort : 'helpful';
  const limit = !query.limit || !Number.isFinite(query.limit)
    ? REVIEWS_DEFAULT_LIMIT
    : Math.min(Math.max(Math.trunc(query.limit), 1), REVIEWS_MAX_LIMIT);
  const offset = decodeOffsetCursor(query.cursor);
  const where: SQL[] = [sql`listing_id = ${listing.id}`];
  if (query.rating !== undefined && Number.isInteger(query.rating) && query.rating >= 1 && query.rating <= 5) {
    where.push(sql`rating = ${query.rating}`);
  }
  const rows = resultRows<ReviewRow>(await db.execute(sql`
    SELECT id, version, rating, title, body_html, author_display_name, verified_use, helpful_count, edited,
           created_at, updated_at, publisher_display_name, reply_body_html, reply_created_at, reply_updated_at,
           COUNT(*) OVER () AS total
      FROM public_reviews
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY ${reviewOrder(sort)}
     LIMIT ${limit} OFFSET ${offset}`));
  const total = rows.length > 0 ? num(rows[0]!.total) : 0;
  return {
    reviews: rows.map(toPublicReview),
    total,
    nextCursor: offset + rows.length < total ? encodeOffsetCursor(offset + rows.length) : null,
  };
}

/** Every public listing's URL parts + last update, for the sitemap. */
export async function listPublicListingsForSitemap(max = 5000): Promise<{ publisher: string; name: string; updatedAt: string }[]> {
  const db = getPublicReaderDb();
  const res = await db.execute(sql`
    SELECT publisher_handle, name, updated_at FROM public_listings
     WHERE paused_at IS NULL ORDER BY updated_at DESC LIMIT ${Math.min(Math.max(max, 1), 50_000)}`);
  return resultRows<{ publisher_handle: string; name: string; updated_at: Date | string }>(res)
    .map((r) => ({ publisher: r.publisher_handle, name: r.name, updatedAt: iso(r.updated_at) }));
}
