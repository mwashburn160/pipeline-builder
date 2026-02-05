/**
 * @module utils/response
 * @description Standardized response utilities for API microservices.
 */

import { Response } from 'express';
import { QuotaInfo } from '../types/common';
import { ErrorCode, ErrorCodeStatus } from '../types/error-codes';

/**
 * Send a standardized success response.
 *
 * @param res - Express response object
 * @param statusCode - HTTP status code (default: 200)
 * @param data - Response data
 * @param message - Optional success message
 *
 * @example
 * ```typescript
 * sendSuccess(res, 200, { plugin: pluginData });
 * sendSuccess(res, 201, { id: newId }, 'Resource created');
 * ```
 */
export function sendSuccess<T>(
  res: Response,
  statusCode: number = 200,
  data?: T,
  message?: string,
): void {
  const response: {
    success: true;
    statusCode: number;
    data?: T;
    message?: string;
  } = {
    success: true,
    statusCode,
  };

  if (data !== undefined) {
    response.data = data;
  }

  if (message) {
    response.message = message;
  }

  res.status(statusCode).json(response);
}

/**
 * Send a standardized error response.
 *
 * @param res - Express response object
 * @param statusCode - HTTP status code
 * @param message - Error message
 * @param code - Error code from ErrorCode enum
 * @param details - Optional additional details
 *
 * @example
 * ```typescript
 * sendError(res, 404, 'Plugin not found', ErrorCode.NOT_FOUND);
 * sendError(res, 400, 'Invalid input', ErrorCode.VALIDATION_ERROR, { field: 'name' });
 * ```
 */
export function sendError(
  res: Response,
  statusCode: number,
  message: string,
  code?: ErrorCode | string,
  details?: unknown,
): void {
  const response: {
    success: false;
    statusCode: number;
    message: string;
    code?: string;
    details?: unknown;
  } = {
    success: false,
    statusCode,
    message,
  };

  if (code) {
    response.code = code;
  }

  if (details !== undefined) {
    response.details = details;
  }

  res.status(statusCode).json(response);
}

/**
 * Send a quota exceeded error response.
 *
 * @param res - Express response object
 * @param quotaType - Type of quota exceeded
 * @param quota - Current quota information
 * @param resetAt - ISO timestamp when quota resets
 *
 * @example
 * ```typescript
 * sendQuotaExceeded(res, 'apiCalls', { type: 'apiCalls', limit: 10000, used: 10000, remaining: 0 }, resetAt);
 * ```
 */
export function sendQuotaExceeded(
  res: Response,
  quotaType: string,
  quota: QuotaInfo,
  resetAt?: string,
): void {
  const resetDate = resetAt ? new Date(resetAt) : new Date();
  const resetIn = Math.max(0, Math.ceil((resetDate.getTime() - Date.now()) / 1000));

  res.setHeader('Retry-After', resetIn);
  res.setHeader('X-Quota-Limit', quota.limit);
  res.setHeader('X-Quota-Used', quota.used);
  res.setHeader('X-Quota-Remaining', Math.max(0, quota.remaining));

  if (resetAt) {
    res.setHeader('X-Quota-Reset', resetAt);
  }

  res.status(429).json({
    success: false,
    statusCode: 429,
    message: `${quotaType} quota exceeded (${quota.used}/${quota.limit}). Please try again later.`,
    code: ErrorCode.QUOTA_EXCEEDED,
    quota,
  });
}

/**
 * Send an error using an ErrorCode enum value.
 * Automatically determines the HTTP status code.
 *
 * @param res - Express response object
 * @param code - Error code from ErrorCode enum
 * @param message - Error message
 * @param details - Optional additional details
 *
 * @example
 * ```typescript
 * sendErrorByCode(res, ErrorCode.NOT_FOUND, 'Plugin not found');
 * sendErrorByCode(res, ErrorCode.VALIDATION_ERROR, 'Invalid name', { field: 'name' });
 * ```
 */
export function sendErrorByCode(
  res: Response,
  code: ErrorCode,
  message: string,
  details?: unknown,
): void {
  const statusCode = ErrorCodeStatus[code] || 500;
  sendError(res, statusCode, message, code, details);
}

/**
 * Paginated response interface.
 */
export interface PaginatedResponse<T> {
  success: true;
  statusCode: number;
  message?: string;
  data: T[];
  count: number;
  limit: number;
  offset: number;
  total?: number;
}

/**
 * Send a paginated list response.
 *
 * @param res - Express response object
 * @param data - Array of items to return
 * @param options - Pagination options
 *
 * @example
 * ```typescript
 * const plugins = await db.query.plugins.findMany({ limit, offset });
 * sendPaginated(res, plugins, {
 *   limit: 10,
 *   offset: 0,
 *   total: 50,
 *   message: 'Plugins retrieved successfully',
 * });
 * ```
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  options: {
    limit: number;
    offset: number;
    total?: number;
    message?: string;
    statusCode?: number;
  },
): void {
  const { limit, offset, total, message, statusCode = 200 } = options;

  const response: PaginatedResponse<T> = {
    success: true,
    statusCode,
    data,
    count: data.length,
    limit,
    offset,
  };

  if (message) {
    response.message = message;
  }

  if (total !== undefined) {
    response.total = total;
  }

  res.status(statusCode).json(response);
}

/**
 * Extract database error details for logging/response.
 *
 * Extracts PostgreSQL error codes, details, hints, and constraint names
 * from database errors for better error messages.
 *
 * @param error - Error object from database operation
 * @returns Object with extracted error details
 *
 * @example
 * ```typescript
 * try {
 *   await db.insert(plugins).values(newPlugin);
 * } catch (error) {
 *   const dbDetails = extractDbError(error);
 *   return sendError(res, 500, 'Database error', ErrorCode.DATABASE_ERROR, dbDetails);
 * }
 * ```
 */
export function extractDbError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return {};
  }

  const dbError = error as Record<string, unknown>;
  const details: Record<string, unknown> = {};

  if (dbError.code) details.dbCode = dbError.code;
  if (dbError.detail) details.dbDetail = dbError.detail;
  if (dbError.hint) details.dbHint = dbError.hint;
  if (dbError.constraint) details.constraint = dbError.constraint;
  if (dbError.table) details.table = dbError.table;
  if (dbError.column) details.column = dbError.column;

  return details;
}
