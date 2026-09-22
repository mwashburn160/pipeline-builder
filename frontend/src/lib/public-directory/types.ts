// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shapes of the PUBLIC plugin directory API (`/api/public/plugins*`).
 * Public rows only — never tenant fields.
 */

export type TrustTier = 'official' | 'verified' | 'community' | 'unverified';
export type IconKind = 'vendor' | 'uploaded' | 'monogram' | 'category';
export type ListingState = 'listed' | 'unmaintained' | 'suspended';

export interface ListingPublisher {
  handle: string;
  displayName: string;
  tier: TrustTier;
}

export interface ListingCard {
  publisher: ListingPublisher;
  name: string;
  summary: string;
  category: string;
  keywords: string[];
  latestVersion: string;
  license: string;
  /** Set only for `iconKind: 'uploaded'` (a same-origin URL). */
  iconUrl: string | null;
  iconKind: IconKind;
  /** Curated icon key (`trivy`) for `iconKind: 'vendor'`; the frontend resolves
   *  its URL and brand colour from the build-time manifest (`@/generated/plugin-icons`). */
  iconKey: string | null;
  /** Null for vendor icons (the manifest carries the colour). */
  iconHex: string | null;
  /** Language badge key (`python`) drawn in the icon's corner, vendor icons only. */
  iconBadge: string | null;
  rating: { score: number; count: number } | null;
  installCount: number;
  /** 0–100 health score; null when fewer than three signals are known. */
  healthScore?: number | null;
  updatedAt: string;
  state: ListingState;
  /** Match highlighting: the strings contain only `<mark>` tags; everything else is text. */
  highlight?: { name?: string; summary?: string };
}

export interface SearchFacets {
  category: Record<string, number>;
  tier: Record<string, number>;
  license: Record<string, number>;
  computeType: Record<string, number>;
  needsSecrets: { true: number; false: number };
}

export interface SearchResult {
  items: ListingCard[];
  facets: SearchFacets;
  total: number;
  nextCursor: string | null;
}

export interface CategorySummary {
  id: string;
  count: number;
  top: ListingCard[];
}

export interface ListingVersion {
  version: string;
  publishedAt: string;
  breaking: boolean;
  deprecated: boolean;
  deprecationMessage: string | null;
  yanked: boolean;
  changelog: string | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  scannedAt: string | null;
  /** Ids of the published advisories whose range covers this version. */
  advisoryIds: string[];
}

export interface ListingConfiguration {
  secrets: { name: string; required: boolean; description: string }[];
  requiredMetadata: string[];
  requiredVars: string[];
  computeType: string;
  primaryOutputDirectory: string | null;
  networkEgress: string[];
  pluginType: string;
}

export interface ListingSupplyChain {
  signed: boolean;
  digest: string | null;
  imageSource: string | null;
  scannedAt: string | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  sbomUrl: string | null;
}

export interface ListingAdvisory {
  id: string;
  severity: string;
  summary: string;
  affectedRange: string;
  fixedVersion: string | null;
  publishedAt: string;
  /** Server-sanitized HTML (injected as-is, like the README). */
  detailsHtml: string | null;
  cveIds: string[];
}

export type RatingBucket = '1' | '2' | '3' | '4' | '5';

export interface ListingDetail extends ListingCard {
  /** README rendered and sanitized SERVER-side; injected as-is, never re-rendered here. */
  readmeHtml: string | null;
  description: string;
  homepageUrl: string | null;
  sourceUrl: string | null;
  versions: ListingVersion[];
  configuration: ListingConfiguration;
  supplyChain: ListingSupplyChain;
  advisories: ListingAdvisory[];
  ratingDistribution: Record<RatingBucket, number> | null;
  /** Rating over the last two minor versions; null when too few reviews. */
  recentRating: number | null;
  activeOrgCount: number | null;
  /** Per-signal scores behind `healthScore`. */
  healthBreakdown?: HealthBreakdown | null;
  /** 30-day runtime success rate (0..1), null with no runs. */
  successRate30d?: number | null;
}

/** One health signal: its 0..1 score (null = not enough data, left out) and its weight. */
export interface HealthComponentScore {
  score: number | null;
  weight: number;
}
export type HealthBreakdown = Partial<Record<string, HealthComponentScore>>;

/** A publisher's public response to a review. `bodyHtml` is server-sanitized. */
export interface ReviewReply {
  bodyHtml: string;
  publisherDisplayName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One published review (`GET /api/public/plugins/:publisher/:name/reviews`).
 * `bodyHtml` is rendered and sanitized SERVER-side; `author` is null once the
 * reviewer's account is gone. The reviewer's org is never part of it.
 */
export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  bodyHtml: string | null;
  version: string | null;
  author: { displayName: string } | null;
  verifiedUse: boolean;
  helpfulCount: number;
  edited: boolean;
  createdAt: string;
  updatedAt: string;
  reply: ReviewReply | null;
}

export interface ReviewPage {
  reviews: PublicReview[];
  total: number;
  nextCursor: string | null;
}

/** Sorts the public reviews API accepts. */
export const REVIEW_SORTS = ['helpful', 'recent', 'highest', 'lowest'] as const;
export type ReviewSort = typeof REVIEW_SORTS[number];

export const REVIEW_SORT_LABELS: Record<ReviewSort, string> = {
  helpful: 'Most helpful',
  recent: 'Newest',
  highest: 'Highest rated',
  lowest: 'Lowest rated',
};

/** Sorts the search API accepts. */
export const SEARCH_SORTS = ['relevance', 'rating', 'installs', 'health', 'updated', 'name'] as const;
export type SearchSort = typeof SEARCH_SORTS[number];

export const SORT_LABELS: Record<SearchSort, string> = {
  relevance: 'Relevance',
  rating: 'Rating',
  installs: 'Most installed',
  health: 'Health',
  updated: 'Recently updated',
  name: 'A–Z',
};

export const TRUST_TIERS: readonly TrustTier[] = ['official', 'verified', 'community', 'unverified'];

export const TRUST_TIER_LABELS: Record<TrustTier, string> = {
  official: 'Official',
  verified: 'Verified',
  community: 'Community',
  unverified: 'Unverified',
};

/** The publisher whose plugins are the platform's own (Official tier). */
export const OFFICIAL_PUBLISHER = 'pipeline-builder';

/** One sitemap row: a listing's URL parts and last update. */
export interface SitemapListing {
  publisher: string;
  name: string;
  updatedAt: string;
}
