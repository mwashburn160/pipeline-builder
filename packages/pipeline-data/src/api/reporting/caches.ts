// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two report caches. A separate module because both the service (for
 * invalidation) and the extracted query modules (via runReport) need them, and a
 * shared singleton must have exactly one definition site.
 *
 * Inventory reads (plugin summary/distribution/versions) change rarely — 5 min.
 * Timeseries reads (execution/build metrics over a range) — 2 min.
 */

import { createCacheService, envInt } from '@pipeline-builder/api-core';

export const inventoryCache = createCacheService('report:inv:', envInt('CACHE_TTL_REPORT_INVENTORY', 300, { min: 1 }));
export const timeseriesCache = createCacheService('report:ts:', envInt('CACHE_TTL_REPORT_TIMESERIES', 120, { min: 1 }));

/** Drop every cached report for an org — called after an ingest/write that
 *  could change any of them. Both caches are pattern-invalidated because a
 *  single write (an event, a deploy outcome, an incident) can move inventory
 *  and timeseries numbers alike. */
export async function invalidateOrgReports(orgId: string): Promise<void> {
  await Promise.all([
    inventoryCache.invalidatePattern(`${orgId}:*`),
    timeseriesCache.invalidatePattern(`${orgId}:*`),
  ]);
}
