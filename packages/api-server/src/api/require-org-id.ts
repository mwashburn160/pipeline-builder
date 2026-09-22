// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, sendError } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';

/**
 * Create middleware that validates the request has a resolved tenant org (`ctx.identity.orgId`).
 *
 * @returns Express middleware
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 *
 * app.get('/pipelines', requireAuth, requireOrgId(), handler);
 * ```
 */
export function requireOrgId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = getContext(req);

    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from the request identity');
      sendError(res, 400, 'Organization ID is required: the caller has no active organization.', ErrorCode.VALIDATION_ERROR);
      return;
    }

    next();
  };
}
