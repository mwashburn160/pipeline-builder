// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client for the PUBLIC plugin directory API.
 *
 * Deliberately NOT the shared `api` client (`@/lib/api/core`): that one always
 * attaches the session's `Authorization` and `x-org-id` headers. The public API
 * ignores both, and its responses are CDN-cached and must never vary on who is
 * asking — so this helper sends no credentials of any kind: no auth headers, no
 * org header, and `credentials: 'omit'` so the browser drops cookies too.
 *
 * Called from `getServerSideProps` (the pages are SSR so they work without JS
 * and are indexable), where the base is the internal platform URL.
 */
import { API_URL } from '@/lib/api/util';
import { toSearchString, type DirectoryQuery } from './query';
import type { CategorySummary, ListingDetail, ReviewPage, ReviewSort, SearchResult, SitemapListing } from './types';

/** Upper bound on one directory request, so a slow API can't hang page renders. */
const PUBLIC_API_TIMEOUT_MS = 8_000;

/** The outcome of a public API call: the data, "not listed / directory off", or a failure. */
export type PublicResult<T> =
  | { ok: true; data: T }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; status: number };

/** Headers for every public request. Exported so tests can pin "no credentials". */
export const PUBLIC_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ Accept: 'application/json' });

/** GET a public directory endpoint. Never throws: network errors come back as `status: 0`. */
export async function publicGet<T>(path: string): Promise<PublicResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_API_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/api/public${path}`, {
      method: 'GET',
      headers: { ...PUBLIC_REQUEST_HEADERS },
      credentials: 'omit',
      signal: controller.signal,
    });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, notFound: false, status: res.status };
    const body = (await res.json()) as { data?: T };
    if (!body || body.data === undefined) return { ok: false, notFound: false, status: 502 };
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, notFound: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Search / list listings. `limit` is optional (the API has its own default). */
export function searchListings(query: DirectoryQuery, limit?: number): Promise<PublicResult<SearchResult>> {
  return publicGet<SearchResult>(`/plugins${toSearchString(query, limit ? { limit } : {})}`);
}

/** Every category with its live count and top listings. */
export function getCategories(): Promise<PublicResult<{ categories: CategorySummary[] }>> {
  return publicGet<{ categories: CategorySummary[] }>('/plugins/categories');
}

/** One listing's page data. */
export function getListing(publisher: string, name: string): Promise<PublicResult<{ listing: ListingDetail }>> {
  return publicGet<{ listing: ListingDetail }>(`/plugins/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`);
}

/** Every listed plugin's URL parts, for the sitemap (one call). */
export function getSitemapListings(): Promise<PublicResult<{ entries: SitemapListing[] }>> {
  return publicGet<{ entries: SitemapListing[] }>('/plugins/sitemap');
}

/** One page of a listing's published reviews (fetched in the browser, still credential-free). */
export function getListingReviews(
  publisher: string,
  name: string,
  params: { sort?: ReviewSort; rating?: number; cursor?: string; limit?: number } = {},
): Promise<PublicResult<ReviewPage>> {
  const qs = new URLSearchParams();
  if (params.sort) qs.set('sort', params.sort);
  if (params.rating) qs.set('rating', String(params.rating));
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  const tail = qs.toString();
  return publicGet<ReviewPage>(
    `/plugins/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/reviews${tail ? `?${tail}` : ''}`,
  );
}
