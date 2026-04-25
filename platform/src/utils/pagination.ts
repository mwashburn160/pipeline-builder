// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { config } from '../config';

export interface PaginationResult {
  offset: number;
  limit: number;
}

/** Parse offset/limit from query params with safe defaults and clamping. */
export function parsePagination(
  offset: unknown,
  limit: unknown,
  defaults?: { maxLimit?: number; defaultLimit?: number },
): PaginationResult {
  const maxLimit = defaults?.maxLimit ?? config.pagination.maxLimit;
  const defaultLimit = defaults?.defaultLimit ?? config.pagination.defaultLimit;
  const limitNum = Math.min(maxLimit, Math.max(1, parseInt(String(limit), 10) || defaultLimit));
  const offsetNum = Math.max(0, parseInt(String(offset), 10) || 0);
  return { offset: offsetNum, limit: limitNum };
}
