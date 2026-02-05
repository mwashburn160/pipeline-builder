/**
 * @module utils/params
 * @description Utilities for handling Express 5 route parameters.
 *
 * In Express 5, route parameters can be `string | string[]`.
 * These utilities provide type-safe parameter extraction.
 */

import { Request } from 'express';
import { getHeaderString } from './headers';

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
 * Extract a required string parameter from Express 5 route params.
 * Throws an error if the parameter is missing.
 *
 * @param params - Request params object
 * @param key - Parameter key
 * @returns The parameter value as a string
 * @throws Error if parameter is missing
 *
 * @example
 * ```typescript
 * try {
 *   const id = getRequiredParam(req.params, 'id');
 *   // id is guaranteed to be a string
 * } catch (err) {
 *   return sendError(res, 400, err.message);
 * }
 * ```
 */
export function getRequiredParam(
  params: Record<string, ParamValue>,
  key: string,
): string {
  const value = getParam(params, key);
  if (value === undefined || value === '') {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return value;
}

/**
 * Extract multiple parameters from Express 5 route params.
 *
 * @param params - Request params object
 * @param keys - Array of parameter keys
 * @returns Object with parameter values
 *
 * @example
 * ```typescript
 * // Route: GET /orgs/:orgId/plugins/:pluginId
 * const { orgId, pluginId } = getParams(req.params, ['orgId', 'pluginId']);
 * ```
 */
export function getParams<K extends string>(
  params: Record<string, ParamValue>,
  keys: K[],
): Record<K, string | undefined> {
  const result = {} as Record<K, string | undefined>;
  for (const key of keys) {
    result[key] = getParam(params, key);
  }
  return result;
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
  const headerOrgId = getHeaderString(req.headers['x-org-id']);
  if (headerOrgId) {
    return headerOrgId;
  }

  // Check authenticated user
  if (req.user?.organizationId) {
    return req.user.organizationId;
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
