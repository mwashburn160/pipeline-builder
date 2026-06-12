// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-core';
import type { Request, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';

/**
 * Establish the request's row-level-security tenant scope.
 *
 * Runs the rest of the request inside `runWithTenantContext({ orgId, isSuperAdmin })`
 * (an AsyncLocalStorage scope) so every `withTenantTx` query downstream can `SET LOCAL`
 * the Postgres GUCs that RLS policies read. Without this, reads against FORCE-RLS tables
 * (e.g. `plugins`, `pipelines`) run with empty GUCs and silently return no rows — the
 * "set once at the request boundary" bookend the RLS enforcement plan calls for.
 *
 * The org is the CALLER's identity org (`ctx.identity.orgId`, validated by requireOrgId),
 * NOT `getOrgId(req)` — the latter prefers route params (the queried scope), which is the
 * wrong tenant for RLS. Must be placed AFTER `requireAuth` + `requireOrgId`.
 */
export function withTenantContext() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = getContext(req);
    runWithTenantContext({ orgId: ctx.identity.orgId, isSuperAdmin: isSystemAdmin(req) }, () => next());
  };
}
