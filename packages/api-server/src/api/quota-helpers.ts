// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incrementQuota, type QuotaService, type QuotaType } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import type { RequestContext } from './request-types';

/**
 * Increment a quota counter using values pulled from a route context.
 *
 * Wraps `incrementQuota(quotaService, orgId, type, authHeader, logWarn)` so
 * route handlers don't have to re-derive `req.headers.authorization` and
 * `ctx.log.bind(null, 'WARN')` at every call site.
 *
 * @example
 * ```typescript
 * router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
 *   // ...
 *   incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
 * }));
 * ```
 */
export function incrementQuotaFromCtx(
  quotaService: QuotaService,
  rc: { req: Request; ctx: RequestContext; orgId: string },
  type: QuotaType,
): void {
  incrementQuota(
    quotaService,
    rc.orgId,
    type,
    rc.req.headers.authorization || '',
    rc.ctx.log.bind(null, 'WARN'),
  );
}
