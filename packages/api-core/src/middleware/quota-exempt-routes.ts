// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The routes that never spend `apiCalls` (or `automationCalls`), fleet-wide.
 *
 * Every service meters and gates its authenticated user surface on `apiCalls`
 * (`meterQuotaOnSuccess` + `checkQuota`, mounted at the app-routes level). A few
 * reads are made BY THE CONSOLE ITSELF, on every page load or on a timer, not by
 * a person doing something — metering them would burn an idle tab's org budget
 * all day, and gating them would make a quota-exhausted org's console unable to
 * render the very banner that says so. This list is that carve-out, and it is
 * deliberately short: each entry names its caller and why it is free.
 *
 * ONE list, read in three places, so they cannot drift:
 *   - `meterQuotaOnSuccess` skips a matching request (no increment);
 *   - `checkQuota` skips a matching request (never 429s);
 *   - `buildRouteTable` marks the route `quota.exempt`, and the quota coverage
 *     check (api-core testing) treats it as covered.
 *
 * Each `path` is matched against BOTH the concrete request path
 * (`/organization/64f…/seat-usage`) and the route-table pattern
 * (`/organization/:id/seat-usage`), so a `:param` segment is written as
 * `[^/]+`. Paths are service-local (nginx strips `/api`).
 *
 * The quota service itself is not on the list because it meters nothing: its
 * reads (`GET /quotas`, which QuotaBanner polls every 60s) never cost a call.
 * Documented in docs/quotas.md ("Exempt routes").
 */
export interface QuotaExemptRoute {
  method: 'GET' | 'POST';
  /** Anchored pattern over the service-local path. */
  path: RegExp;
  /** Who calls it, and why it must be free. */
  reason: string;
}

export const QUOTA_EXEMPT_ROUTES: readonly QuotaExemptRoute[] = [
  {
    method: 'GET',
    path: /^\/user\/profile$/,
    reason: 'Session bootstrap: the console reads the signed-in profile on every page load.',
  },
  {
    method: 'GET',
    path: /^\/user\/organizations$/,
    reason: 'The org switcher, read on every page load.',
  },
  {
    method: 'GET',
    path: /^\/organization\/[^/]+\/feature-entitlements$/,
    reason: 'Navigation gating (which features render unlocked), read on every page load.',
  },
  {
    method: 'GET',
    path: /^\/organization\/[^/]+\/seat-usage$/,
    reason: 'Billing/quota page read beside the (unmetered) quota reads; an exhausted org must still see what it is using.',
  },
  {
    method: 'GET',
    path: /^\/messages\/unread\/count$/,
    reason: 'The sidebar unread badge, polled every 30s whenever the live channel is down.',
  },
  {
    method: 'POST',
    path: /^\/messages\/notifications\/ticket$/,
    reason: 'SSE ticket mint for the live notification channel; re-minted on every reconnect.',
  },
  {
    method: 'POST',
    path: /^\/reports\/execution\/stream\/ticket$/,
    reason: 'SSE ticket mint for the live execution-status channel; re-minted on every reconnect.',
  },
];

/** Whether `method` + `path` (a request path or a route-table pattern) is quota-exempt. */
export function isQuotaExemptRoute(method: string | undefined, path: string): boolean {
  // HEAD is GET without a body (Express folds it the same way).
  const upper = (method ?? '').toUpperCase();
  const m = upper === 'HEAD' ? 'GET' : upper;
  return QUOTA_EXEMPT_ROUTES.some((r) => r.method === m && r.path.test(path));
}
