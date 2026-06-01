// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { parsePaginationParams } from '@pipeline-builder/api-core';

export interface PaginationResult {
  offset: number;
  limit: number;
}

/**
 * Back-compat shim for the legacy `parsePagination(offset, limit)` helper.
 *
 * The canonical implementation now lives in `@pipeline-builder/api-core` as
 * `parsePaginationParams(req.query)`, which also returns `sortBy` and
 * `sortOrder`. This shim adapts the older two-argument signature so existing
 * callers in routes/controllers keep working unchanged.
 *
 * TODO([route] agent): migrate callers to import `parsePaginationParams`
 * directly from `@pipeline-builder/api-core` and pass `req.query`, then
 * delete this shim.
 */
export function parsePagination(
  offset: unknown,
  limit: unknown,
  _defaults?: { maxLimit?: number; defaultLimit?: number },
): PaginationResult {
  // `parsePaginationParams` reads `query.limit` / `query.offset` so we just
  // synthesize the minimal query object it expects. The `defaults` param is
  // intentionally accepted-and-ignored — api-core uses its own MAX_PAGE_LIMIT
  // and a fixed default of 10. Callers that need custom bounds should move
  // off this shim.
  const { limit: l, offset: o } = parsePaginationParams({ limit, offset });
  return { offset: o, limit: l };
}
