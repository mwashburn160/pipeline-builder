// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin } from '@pipeline-builder/api-core';
import { runWithTenantContext, type TenantContext } from '@pipeline-builder/pipeline-core';
import type { Request, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';

/**
 * Resolves the RLS tenant scope for a request. The default reads the CALLER's
 * authenticated identity org (`ctx.identity.orgId`, validated by requireOrgId) — NOT
 * `getOrgId(req)`, which prefers route params (the queried scope), the wrong tenant for
 * RLS. Services with a different request boundary supply their own resolver (e.g. platform
 * sets the scope pre-auth from an unverified JWT peek so unauthenticated endpoints still
 * get a sane default).
 */
export type TenantScopeResolver = (req: Request) => TenantContext;

/** Default resolver: the authenticated identity's org + super-admin flag. */
const identityScope: TenantScopeResolver = (req) => ({
  orgId: getContext(req).identity.orgId,
  isSuperAdmin: isSystemAdmin(req),
});

/**
 * Establish the request's row-level-security tenant scope.
 *
 * Runs the rest of the request inside `runWithTenantContext({ orgId, isSuperAdmin })` (an
 * AsyncLocalStorage scope) so every `withTenantTx` query downstream can `SET LOCAL` the
 * Postgres GUCs that RLS policies read. Without this, reads against FORCE-RLS tables (e.g.
 * `plugins`, `pipelines`) run with empty GUCs and silently return no rows — the "set once
 * at the request boundary" bookend the RLS enforcement plan calls for.
 *
 * Default placement is AFTER `requireAuth` + `requireOrgId` (the route factories do this);
 * pass a custom `resolve` for a different boundary. A thrown resolver means tenant identity
 * could NOT be established (a wiring bug — this runs after auth) — we hard-FAIL the request
 * (500 via next(err)) rather than proceed. Proceeding would run queries with empty RLS GUCs;
 * under FORCE RLS that hides rows, but while RLS is in owner-bypass mode the app-layer WHERE
 * clause is the only tenant gate, so a scopeless request must not silently continue.
 */
export function withTenantContext(resolve: TenantScopeResolver = identityScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    let scope: TenantContext;
    try {
      scope = resolve(req);
    } catch (err) {
      next(err);
      return;
    }
    runWithTenantContext(scope, () => next());
  };
}
