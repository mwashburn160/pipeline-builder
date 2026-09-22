// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The `pagination` envelope every platform list route returns. */
export interface PaginationMeta {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Build the envelope for one page. `hasMore` is whether rows remain past this
 * page: past `offset + limit` by default, or past `offset + returned` for a
 * route whose page can be shorter than its limit (an unpaged "everything"
 * answer reports `limit = total`).
 */
export function paginationMeta(total: number, offset: number, limit: number, returned?: number): PaginationMeta {
  return { total, offset, limit, hasMore: offset + (returned ?? limit) < total };
}
