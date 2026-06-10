// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request } from 'express';
import { getHeaderString } from './headers.js';

/**
 * Express 5 parameter type.
 */
type ParamValue = string | string[] | undefined;

/**
 * Extract a single string parameter from Express 5 route params.
 *
 * @param params - Request params object
 * @param key - Parameter key
 * @returns The parameter value as a string, or undefined if not present
 *
 * @example
 * ```typescript
 * // Route: GET /plugins/:id
 * const id = getParam(req.params, 'id');
 * if (!id) {
 *   return sendError(res, 400, 'Missing id parameter');
 * }
 * ```
 */
export function getParam(
  params: Record<string, ParamValue>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Extract the organization ID from request.
 * Checks params, headers, and user object.
 *
 * @param req - Express request object
 * @returns Organization ID or undefined
 *
 * @example
 * ```typescript
 * const orgId = getOrgId(req);
 * if (!orgId) {
 *   return sendError(res, 400, 'Organization ID required');
 * }
 * ```
 */
export function getOrgId(req: Request): string | undefined {
  // Check route params first
  const paramOrgId = getParam(req.params, 'orgId');
  if (paramOrgId) {
    return paramOrgId;
  }

  // Check x-org-id header
  const headerOrgId = getHeaderString(req.headers['x-org-id'])?.trim();
  if (headerOrgId) {
    return headerOrgId;
  }

  // Check authenticated user
  const userOrgId = req.user?.organizationId?.trim();
  if (userOrgId) {
    return userOrgId;
  }

  return undefined;
}

/**
 * Get the authorization header from request.
 *
 * @param req - Express request object
 * @returns Authorization header value or empty string
 */
export function getAuthHeader(req: Request): string {
  return getHeaderString(req.headers.authorization) ?? '';
}

/**
 * Parse a query parameter as a boolean.
 *
 * @param value - Query parameter value
 * @returns Parsed boolean or undefined
 *
 * @example
 * ```typescript
 * const isActive = parseQueryBoolean(req.query.isActive);
 * ```
 */
export function parseQueryBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
  }
  return undefined;
}

/**
 * Parse a query parameter as an integer.
 *
 * @param value - Query parameter value
 * @param defaultValue - Default value if parsing fails
 * @returns Parsed integer
 *
 * @example
 * ```typescript
 * const limit = parseQueryInt(req.query.limit, 10);
 * const offset = parseQueryInt(req.query.offset, 0);
 * ```
 */
export function parseQueryInt(value: unknown, defaultValue: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = parseInt(String(value), 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse a query parameter as a string.
 *
 * @param value - Query parameter value
 * @returns String value or undefined
 *
 * @example
 * ```typescript
 * const search = parseQueryString(req.query.search);
 * ```
 */
export function parseQueryString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

/**
 * Parse a string to a positive integer, returning a fallback if invalid.
 * Useful for parsing environment variables with numeric defaults.
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a query int, then clamp to `[1, max]`. Returns `defaultValue` (after
 * the same clamp) when the input is missing/invalid. Use for `limit`-style
 * query parameters where an unbounded value would cost real money.
 *
 * @example
 * const limit = parseQueryIntClamped(req.query.limit, 50, 1000);
 */
export function parseQueryIntClamped(
  value: unknown,
  defaultValue: number,
  max: number,
): number {
  const raw = parseQueryInt(value, defaultValue);
  return Math.max(1, Math.min(raw, max));
}

/**
 * Bulk-array request guard. Validates that `value` is an array, non-empty,
 * and within the configured cap. Returns the typed array or an error object
 * the caller can forward to `sendError`/`sendBadRequest`.
 *
 * Replaces a hand-rolled `if (!Array.isArray(...)) { ... }` + length check
 * block that was duplicated across bulk endpoints in pipeline, plugin,
 * compliance, etc.
 *
 * @example
 * const result = validateBulkArray(req.body.ids, 'ids');
 * if ('error' in result) return sendBadRequest(res, result.error, ErrorCode.VALIDATION_ERROR);
 * const ids = result.value;
 */
export function validateBulkArray<T = unknown>(
  value: unknown,
  fieldName: string,
  maxItems?: number,
): { value: T[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `Request body must include a non-empty "${fieldName}" array` };
  }
  // CoreConstants.MAX_BULK_ITEMS isn't imported here to avoid a circular
  // path through constants/index; callers pass it explicitly or omit for
  // no upper bound.
  if (maxItems !== undefined && value.length > maxItems) {
    return { error: `Maximum ${maxItems} items per bulk operation` };
  }
  return { value: value as T[] };
}

/**
 * Supported intervals for time-bucketed report queries. Used as the
 * `DATE_TRUNC` first argument in Postgres; restricted to a fixed enum so
 * the value can never be injected into raw SQL.
 */
export const REPORT_INTERVALS = ['day', 'week', 'month'] as const;
export type ReportInterval = (typeof REPORT_INTERVALS)[number];

/**
 * Parse a `?from=&to=` date range with defaults of "30 days ago → now".
 * Rejects non-string inputs (Express's parser can produce string[] for
 * repeated keys), invalid ISO timestamps, and inverted ranges.
 *
 * Returns either `{ from, to }` ISO strings or `{ error }`.
 *
 * @example
 * const range = parseDateRange(req.query);
 * if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
 * const rows = await svc.list(range.from, range.to);
 */
export function parseDateRange(
  query: Record<string, unknown>,
  options: { maxRangeMs?: number; defaultDaysBack?: number } = {},
): { from: string; to: string } | { error: string } {
  const { maxRangeMs, defaultDaysBack = 30 } = options;

  const rawFrom = query.from;
  const rawTo = query.to;

  if (rawFrom !== undefined && typeof rawFrom !== 'string') {
    return { error: '"from" must be a single ISO timestamp string' };
  }
  if (rawTo !== undefined && typeof rawTo !== 'string') {
    return { error: '"to" must be a single ISO timestamp string' };
  }

  const now = Date.now();
  const fromStr = rawFrom ?? new Date(now - defaultDaysBack * 24 * 60 * 60 * 1000).toISOString();
  const toStr = rawTo ?? new Date(now).toISOString();

  const fromMs = Date.parse(fromStr);
  const toMs = Date.parse(toStr);
  if (!Number.isFinite(fromMs)) return { error: '"from" is not a valid ISO timestamp' };
  if (!Number.isFinite(toMs)) return { error: '"to" is not a valid ISO timestamp' };
  if (fromMs > toMs) return { error: '"from" must be earlier than "to"' };
  if (maxRangeMs !== undefined && toMs - fromMs > maxRangeMs) {
    return { error: `Date range exceeds maximum of ${Math.floor(maxRangeMs / (24 * 60 * 60 * 1000))} days` };
  }

  return { from: fromStr, to: toStr };
}
