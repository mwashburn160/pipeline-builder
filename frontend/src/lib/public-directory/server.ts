// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `getServerSideProps` plumbing shared by the public directory pages.
 *
 * Successful renders are CDN-cacheable for a minute and served stale for ten
 * while revalidating (§6a). The HTML never depends on the viewer — the API is
 * called without credentials and the header renders its guest variant on the
 * server — so a shared cache is safe. Failures are `no-store`: an outage page
 * must not be cached for everyone.
 */
import type { ServerResponse } from 'node:http';

export const PUBLIC_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=600';

/** Mark a successful directory response as publicly cacheable. */
export function cachePublicly(res: ServerResponse): void {
  res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
}

/**
 * The directory API failed (not a 404): answer 503 with `no-store` and let the
 * page render its "unavailable" state.
 */
export function markUnavailable(res: ServerResponse): void {
  res.statusCode = 503;
  res.setHeader('Cache-Control', 'no-store');
}
