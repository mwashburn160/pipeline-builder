import { config } from '../config';

export interface PaginationResult {
  offset: number;
  limit: number;
}

/** Standard pagination response shape. */
export interface PaginationResponse {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Build pagination response from total count and current offset/limit. */
export function buildPaginationResponse(total: number, offset: number, limit: number): PaginationResponse {
  return { total, offset, limit, hasMore: offset + limit < total };
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
