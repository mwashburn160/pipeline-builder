// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request } from 'express';
import type { RequestContext } from './request-types';

/**
 * Safely retrieve the RequestContext from an Express request.
 *
 * Throws a descriptive error if the context middleware has not been applied,
 * instead of silently returning undefined or crashing with a cryptic error.
 *
 * @param req - Express request object
 * @returns The attached RequestContext
 * @throws Error if req.context is not initialized
 *
 * @example
 * ```typescript
 * app.get('/pipelines', requireAuth, async (req, res) => {
 *   const ctx = getContext(req);
 *   ctx.log('INFO', 'Fetching pipelines');
 *   // ...
 * });
 * ```
 */
export function getContext(req: Request): RequestContext {
  if (!req.context) {
    throw new Error(
      'Request context not initialized. Ensure attachRequestContext middleware is applied.',
    );
  }
  return req.context;
}
