import { config } from '../config';

export interface PaginationResult {
  page: number;
  limit: number;
  skip: number;
}

/** Parse page/limit from query params with safe defaults and clamping. */
export function parsePagination(
  page: unknown,
  limit: unknown,
  defaults?: { maxLimit?: number; defaultLimit?: number },
): PaginationResult {
  const maxLimit = defaults?.maxLimit ?? config.pagination.maxLimit;
  const defaultLimit = defaults?.defaultLimit ?? config.pagination.defaultLimit;
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const limitNum = Math.min(maxLimit, Math.max(1, parseInt(String(limit), 10) || defaultLimit));
  return { page: pageNum, limit: limitNum, skip: (pageNum - 1) * limitNum };
}
