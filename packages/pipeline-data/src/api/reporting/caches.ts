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

import { createCacheService } from '@pipeline-builder/api-core';

export const inventoryCache = createCacheService('report:inv:', parseInt(process.env.CACHE_TTL_REPORT_INVENTORY || '300', 10));
export const timeseriesCache = createCacheService('report:ts:', parseInt(process.env.CACHE_TTL_REPORT_TIMESERIES || '120', 10));
