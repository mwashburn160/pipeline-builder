// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  AppError,
  errorMessage,
  extractDbError,
  sendError,
  sendBadRequest,
  sendInternalError,
  createLogger,
} from '@pipeline-builder/api-core';
import type { Request, Response, RequestHandler } from 'express';
import { getContext } from './get-context.js';
import type { RequestContext } from './request-types.js';

const logger = createLogger('route-wrapper');

/**
 * A log-safe rendering of an unknown error. drizzle-orm's `DrizzleQueryError`
 * embeds the failed SQL statement AND the bound parameter values (real data) in
 * its `.message` (`Failed query: <sql>\nparams: <values>`). Never put that in a
 * response or a log line — collapse it to the error name. Other errors are safe.
 */
function safeErrorForLog(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Failed query:')) {
    return `${error.name || 'DrizzleQueryError'}: database query failed`;
  }
  return errorMessage(error);
}

/**
 * Context object passed to every route handler wrapped with `withRoute()`.
 */
export interface RouteContext {
  /** Original Express request */
  req: Request;
  /** Original Express response */
  res: Response;
  /** Request context with identity and logging */
  ctx: RequestContext;
  /** Lowercased organization ID (guaranteed non-empty when requireOrgId is true) */
  orgId: string;
  /** User ID from JWT (defaults to empty string) */
  userId: string;
}

/**
 * Options for `withRoute()`.
 */
export interface WithRouteOptions {
  /**
   * Whether to require orgId on the request.
   * When true (default), returns 400 if orgId is missing.
   * Set to false for routes that don't need org context.
   */
  requireOrgId?: boolean;
}

/**
 * Wrap an async route handler with standard boilerplate.
 *
 * Extracts context, orgId, userId from the request, validates orgId,
 * and catches errors. Typed `AppError` subclasses are automatically
 * mapped to the correct HTTP response.
 *
 * @param handler - Async function receiving a RouteContext
 * @param options - Configuration options
 * @returns Express RequestHandler
 *
 * @example
 * ```typescript
 * router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
 *   const id = getParam(req.params, 'id');
 *   const result = await pipelineService.findById(id, orgId);
 *   if (!result) throw new NotFoundError('Pipeline not found');
 *   return sendSuccess(res, 200, { pipeline: result });
 * }));
 * ```
 */
export function withRoute(
  handler: (rc: RouteContext) => Promise<void>,
  options: WithRouteOptions = {},
): RequestHandler {
  const { requireOrgId = true } = options;

  return async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';

    if (requireOrgId && !orgId) {
      return sendBadRequest(res, 'Organization ID is required');
    }

    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch (error) {
      // Don't send another response if one was already sent
      if (res.headersSent) {
        logger.error('Route handler error after response sent', {
          requestId: ctx.requestId,
          error: safeErrorForLog(error),
        });
        return;
      }

      if (error instanceof AppError) {
        const status = error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
        return sendError(res, status, error.message, error.code);
      }

      // Unhandled error → 500. NEVER echo the raw message to the client: DB driver
      // errors carry the SQL + bound params, and CrudService deliberately lets them
      // propagate here. Send a generic message + requestId (to correlate with logs),
      // and log only sanitized DB metadata (code/constraint/table — no SQL/params).
      const db = extractDbError(error);
      ctx.log('ERROR', 'Request failed', {
        requestId: ctx.requestId,
        error: safeErrorForLog(error),
        ...(Object.keys(db).length ? { db } : {}),
      });
      return sendInternalError(res, 'Internal server error', { requestId: ctx.requestId });
    }
  };
}
