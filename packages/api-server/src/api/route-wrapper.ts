// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  AppError,
  errorMessage,
  sendError,
  sendBadRequest,
  sendInternalError,
  createLogger,
} from '@pipeline-builder/api-core';
import type { Request, Response, RequestHandler } from 'express';
import { getContext } from './get-context';
import type { RequestContext } from './request-types';

const logger = createLogger('route-wrapper');

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
          error: errorMessage(error),
        });
        return;
      }

      if (error instanceof AppError) {
        const status = error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
        return sendError(res, status, error.message, error.code);
      }

      ctx.log('ERROR', 'Request failed', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  };
}
