// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incrementQuota, type QuotaService, type QuotaType } from '@pipeline-builder/api-core';
import type { RequestContext } from './request-types.js';

/**
 * Increment (meter) a quota counter using values pulled from a route context.
 *
 * Wraps `incrementQuota(quotaService, orgId, type, logWarn)` so route handlers
 * don't have to re-derive `ctx.log.bind(null, 'WARN')` at every call site. The
 * increment authenticates as the calling service (see `incrementQuota`), never
 * with the end user's token.
 *
 * @example
 * ```typescript
 * router.get('/', withRoute(async ({ res, ctx, orgId }) => {
 *   // ...
 *   incrementQuotaFromCtx(quotaService, { ctx, orgId }, 'apiCalls');
 * }));
 * ```
 */
export function incrementQuotaFromCtx(
  quotaService: QuotaService,
  rc: { ctx: RequestContext; orgId: string },
  type: QuotaType,
): void {
  incrementQuota(
    quotaService,
    rc.orgId,
    type,
    rc.ctx.log.bind(null, 'WARN'),
  );
}
