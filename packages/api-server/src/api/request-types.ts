// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getIdentity, createLogger, redactSensitive, type RequestIdentity, type HttpRequest } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { v7 as uuid } from 'uuid';
import { SSEManager, type SSEEventType } from '../http/sse-connection-manager.js';

// Consolidated Express Request augmentations
declare global {
  namespace Express {
    interface Request {
      /** Unique request ID (set by app-factory middleware) */
      requestId?: string;
      /** Request context with identity, logging, and SSE */
      context?: RequestContext;
    }
  }
}

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
    const meta = { requestId, orgId: identity.orgId, type, data };
    switch (type) {
      case 'ERROR':
        logger.error(message, meta);
        break;
      case 'WARN':
        logger.warn(message, meta);
        break;
      default:
        logger.info(message, meta);
        break;
    }
    // The Winston call above is redacted by the logger's `redactFormat`, but the
    // SSE frame bypasses the logger entirely — apply the SAME key-pattern
    // redaction to `data` before it's pushed to the client so a secret in the
    // log payload (e.g. an accidental `token`/`password` field) isn't streamed
    // out over the build-log SSE channel.
    sseManager.send(requestId, type, message, redactSensitive(data));
  };

  return {
    requestId,
    identity,
    log,
  };
}
