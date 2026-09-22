// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { withRoute, type WithRouteOptions } from '@pipeline-builder/api-server';
import type { Request, RequestHandler, Response } from 'express';

import { callerFromRequest, type Caller } from '../services/ecosystem/context.js';

/**
 * `withRoute` for the ecosystem routes: hands the handler the acting
 * {@link Caller}. An `EcosystemError` answers with its code and its
 * structured `details` (the failing gates, the quota standing) through the
 * generic AppError mapping.
 */
export function ecosystemRoute(
  handler: (args: { req: Request; res: Response; caller: Caller }) => Promise<void>,
  options: WithRouteOptions = {},
): RequestHandler {
  return withRoute(async ({ req, res }) => {
    await handler({ req, res, caller: callerFromRequest(req) });
  }, options) as RequestHandler;
}

/** The request body as a plain object (never null / an array). */
export function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

/** A route parameter as a string. */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}
