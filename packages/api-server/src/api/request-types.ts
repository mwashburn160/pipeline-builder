/**
 * @module api/request-types
 * @description Request context factory that combines identity extraction, request tracing, and dual-output logging via Winston and SSE.
 */

import { getIdentity, RequestIdentity, createLogger, HttpRequest } from '@mwashburn160/api-core';
import { Request } from 'express';
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
 * Creates a logger that outputs to both console and SSE.
 *
 * @param req - Express request
 * @param sseManager - SSE manager for real-time logs
 * @returns Request context with identity and logger
 *
 * @example
 * ```typescript
 * app.post('/api/resource', requireAuth, async (req, res) => {
 *   const ctx = createRequestContext(req, sseManager);
 *
 *   ctx.log('INFO', 'Processing request', { data: req.body });
 *
 *   if (!ctx.identity.orgId) {
 *     ctx.log('ERROR', 'Missing organization ID');
 *     return sendBadRequest(res, 'x-org-id header required');
 *   }
 *
 *   // Process request...
 *   ctx.log('COMPLETED', 'Request processed successfully');
 * });
 * ```
 */
export function createRequestContext(
  req: Request,
  sseManager: SSEManager,
): RequestContext {
  const identity = getIdentity(req as HttpRequest);
  // Prefer the already-parsed requestId from app-factory middleware,
  // fall back to identity header, then generate a new one.
  const requestId = req.requestId || identity.requestId || uuid();

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

