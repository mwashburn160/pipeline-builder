import { Request, Response } from 'express';
import { v7 as uuid } from 'uuid';
import { getIdentity, RequestIdentity } from './identity';
import { SSEEventType, SSEManager } from '../http/sse-connection-manager';

/**
 * Generic typed request with body, query, and params
 *
 * @example
 * ```typescript
 * // Request with body
 * type CreateRequest = TypedRequest<{ name: string }>;
 *
 * // Request with query params
 * type SearchRequest = TypedRequest<{}, { q: string }>;
 *
 * // Request with URL params
 * type GetByIdRequest = TypedRequest<{}, {}, { id: string }>;
 * ```
 */
export type TypedRequest<
  TBody = any,
  TQuery = any,
  TParams = any,
> = Request<TParams, any, TBody, TQuery>;

/**
 * Request with only body typing
 */
export type BodyRequest<TBody = any> = Request<any, any, TBody, any>;

/**
 * Request with only query typing
 */
export type QueryRequest<TQuery = any> = Request<any, any, any, TQuery>;

/**
 * Request with only params typing
 */
export type ParamsRequest<TParams = any> = Request<TParams, any, any, any>;

/**
 * Standard API success response
 */
export interface ApiSuccessResponse<T = unknown> {
  message: string;
  data?: T;
  count?: number;
  limit?: number;
  offset?: number;
}

/**
 * Standard API error response
 */
export interface ApiErrorResponse {
  error: string;
  message?: string;
  details?: Record<string, unknown>;
  constraint?: string;
}

/**
 * Paginated list response
 */
export interface PaginatedResponse<T> {
  message: string;
  data: T[];
  count: number;
  limit: number;
  offset: number;
}

/**
 * Request logger function type
 */
export type RequestLogger = (type: SSEEventType, message: string, data?: unknown) => void;

/**
 * Request context with identity and logging
 */
export interface RequestContext {
  /** Unique request ID */
  requestId: string;
  /** Identity from headers */
  identity: RequestIdentity;
  /** Logging function that sends to console and SSE */
  log: RequestLogger;
}

/**
 * Create a request context with identity and logging
 *
 * Sets X-Request-Id header on response and creates a logger
 * that outputs to both console and SSE.
 *
 * @param req - Express request
 * @param res - Express response
 * @param sseManager - SSE manager for real-time logs
 * @returns Request context with identity and logger
 *
 * @example
 * ```typescript
 * app.post('/api/resource', authenticateToken, async (req, res) => {
 *   const ctx = createRequestContext(req, res, sseManager);
 *
 *   ctx.log('INFO', 'Processing request', { data: req.body });
 *
 *   if (!ctx.identity.orgId) {
 *     ctx.log('ERROR', 'Missing organization ID');
 *     return res.status(400).json({ error: 'x-org-id header required' });
 *   }
 *
 *   // Process request...
 *   ctx.log('COMPLETED', 'Request processed successfully');
 * });
 * ```
 */
export function createRequestContext(
  req: Request<any, any, any, any>,
  res: Response,
  sseManager: SSEManager,
): RequestContext {
  const identity = getIdentity(req);
  const requestId = identity.requestId || uuid();

  // Set request ID header for tracing
  res.setHeader('X-Request-Id', requestId);

  // Create logger that outputs to console and SSE
  const log: RequestLogger = (type, message, data) => {
    console.log(`[${requestId}] [${type}] ${message}`, data ?? '');
    sseManager.send(requestId, type, message, data);
  };

  return {
    requestId,
    identity,
    log,
  };
}

/**
 * Send a standard success response
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  message: string = 'Success',
  statusCode: number = 200,
): Response {
  return res.status(statusCode).json({
    message,
    data,
  } as ApiSuccessResponse<T>);
}

/**
 * Send a standard error response
 */
export function sendError(
  res: Response,
  error: string,
  statusCode: number = 500,
  details?: Record<string, unknown>,
): Response {
  const response: ApiErrorResponse = { error };
  if (details) {
    response.details = details;
  }
  return res.status(statusCode).json(response);
}

/**
 * Send a paginated list response
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  message: string,
  limit: number,
  offset: number,
  statusCode: number = 200,
): Response {
  return res.status(statusCode).json({
    message,
    data,
    count: data.length,
    limit,
    offset,
  } as PaginatedResponse<T>);
}

/**
 * Extract database error details for logging/response
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

  return details;
}
