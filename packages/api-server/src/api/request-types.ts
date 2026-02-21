import { getIdentity, RequestIdentity, createLogger, HttpRequest } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import { v7 as uuid } from 'uuid';
import { SSEEventType, SSEManager } from '../http/sse-connection-manager';

const logger = createLogger('api-server');

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
  req: Request,
  res: Response,
  sseManager: SSEManager,
): RequestContext {
  const identity = getIdentity(req as HttpRequest);
  const requestId = identity.requestId || uuid();

  // Set request ID header for tracing
  res.setHeader('X-Request-Id', requestId);

  // Create logger that outputs to Winston and SSE
  const log: RequestLogger = (type, message, data) => {
    logger.info(message, { requestId, orgId: identity.orgId, type, data });
    sseManager.send(requestId, type, message, data);
  };

  return {
    requestId,
    identity,
    log,
  };
}

// Re-export response utilities and types from api-core
// All responses use api-core's standardized format with success flags and status codes:
// - ApiSuccessResponse: { success: true, statusCode, data?, message? }
// - ApiErrorResponse: { success: false, statusCode, message, code?, details?, quota? }
// - PaginatedResponse: { success: true, statusCode, message?, data, count, limit, offset, total? }
export {
  sendSuccess,
  sendError,
  sendPaginated,
  extractDbError,
  type ApiSuccessResponse,
  type ApiErrorResponse,
  type ApiResponse,
  type PaginatedResponse,
} from '@mwashburn160/api-core';
