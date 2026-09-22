// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The directory's URL IS its query (shareable, indexable). These helpers are the
 * one whitelist between an address-bar query string and the public search API:
 * unknown keys are dropped, every value is bounded, and the same shape is used
 * to build page links, so a link can never carry something the API refuses.
 */
import { SEARCH_SORTS, TRUST_TIERS, type SearchSort, type TrustTier } from './types';

export interface DirectoryQuery {
  q?: string;
  category?: string;
  tier?: TrustTier;
  license?: string;
  computeType?: string;
  needsSecrets?: 'true' | 'false';
  minRating?: string;
  sort?: SearchSort;
  cursor?: string;
}

/** Keys in the order they appear in a URL (stable URLs cache better). */
export const DIRECTORY_QUERY_KEYS = [
  'q', 'category', 'tier', 'license', 'computeType', 'needsSecrets', 'minRating', 'sort', 'cursor',
] as const satisfies readonly (keyof DirectoryQuery)[];

/** Keys that narrow the result set (a query with none of these is the directory home). */
const FILTER_KEYS = ['q', 'category', 'tier', 'license', 'computeType', 'needsSecrets', 'minRating'] as const;

const MAX_Q = 200;
const MAX_TOKEN = 128;
const TOKEN_RE = /^[A-Za-z0-9._+\-: ]+$/;

function first(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : undefined;
}

function token(v: unknown): string | undefined {
  const s = first(v)?.trim();
  return s && s.length <= MAX_TOKEN && TOKEN_RE.test(s) ? s : undefined;
}

/** Parse a Next.js `query` (or any record of strings/arrays) into a safe {@link DirectoryQuery}. */
export function parseDirectoryQuery(raw: Record<string, unknown>): DirectoryQuery {
  const out: DirectoryQuery = {};
  const q = first(raw.q)?.replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
  if (q) out.q = q;
  const category = token(raw.category);
  if (category && /^[a-z]+$/.test(category)) out.category = category;
  const tier = first(raw.tier);
  if (tier && (TRUST_TIERS as readonly string[]).includes(tier)) out.tier = tier as TrustTier;
  const license = token(raw.license);
  if (license) out.license = license;
  const computeType = token(raw.computeType);
  if (computeType) out.computeType = computeType;
  const needsSecrets = first(raw.needsSecrets);
  if (needsSecrets === 'true' || needsSecrets === 'false') out.needsSecrets = needsSecrets;
  const minRating = first(raw.minRating);
  if (minRating && /^[1-5]$/.test(minRating)) out.minRating = minRating;
  const sort = first(raw.sort);
  if (sort && (SEARCH_SORTS as readonly string[]).includes(sort)) out.sort = sort as SearchSort;
  const cursor = first(raw.cursor);
  if (cursor && cursor.length <= 512 && /^[A-Za-z0-9_\-=.]+$/.test(cursor)) out.cursor = cursor;
  return out;
}

/** True when the query narrows the catalog (show results rather than the home sections). */
export function isFilteredQuery(query: DirectoryQuery): boolean {
  return FILTER_KEYS.some((k) => query[k] !== undefined);
}

/**
 * How a directory URL presents itself to search engines.
 *
 * The indexable pages are the directory home and one page per category. Every
 * other combination — a search, a facet, a sort, a page past the first — is a
 * view OF those pages: crawlable (`follow`, so the plugin links in it are
 * found) but not indexed (`noindex`), with its canonical pointing at the page
 * it narrows. Before this, each facet permutation was its own indexable page
 * canonicalising to itself: an unbounded set of near-duplicates.
 *
 * `category` is the one browse facet; on `/plugins?category=x` it canonicalises
 * to the category page, which is the same listing with its own copy.
 */
export function directorySeo(query: DirectoryQuery): { canonicalPath: string; noindex: boolean } {
  const { category, ...rest } = query;
  const canonicalPath = category ? `/plugins/category/${encodeURIComponent(category)}` : '/plugins';
  const narrowed = Object.values(rest).some((v) => v !== undefined && v !== '');
  return { canonicalPath, noindex: narrowed };
}

/** `?a=b&…` (or '') for a query, in canonical key order. */
export function toSearchString(query: DirectoryQuery, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams();
  for (const key of DIRECTORY_QUERY_KEYS) {
    const v = query[key];
    if (v !== undefined && v !== '') params.set(key, String(v));
  }
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * The query with one key set (or cleared with `undefined`). Any change resets
 * the cursor — a cursor belongs to the result set it was issued for.
 */
export function withParam<K extends keyof DirectoryQuery>(
  query: DirectoryQuery, key: K, value: DirectoryQuery[K] | undefined,
): DirectoryQuery {
  const next: DirectoryQuery = { ...query };
  delete next.cursor;
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  return next;
}

/** `/plugins?…` for a query. */
export function directoryHref(query: DirectoryQuery): string {
  return `/plugins${toSearchString(query)}`;
}
