// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin, setLogContextProvider } from '@pipeline-builder/api-core';
import { getTenantContext, runWithTenantContext, type TenantContext } from '@pipeline-builder/pipeline-data';
import type { Request, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';

/**
 * Teach the logger where the ambient org/user identity lives — the SINGLE wire
 * point for log tenancy across every service.
 *
 * `api-core` (which owns the logger) has no internal dependencies, and the
 * request scope lives in `pipeline-data`, which depends on it — so the logger
 * takes a provider rather than importing the AsyncLocalStorage directly. This
 * module is the natural place to register: it already bridges both packages,
 * and every service that opens a tenant scope does so through the
 * `withTenantContext` exported below (platform included, via its own pre-auth
 * resolver). Registering here rather than in each service's bootstrap means a
 * new service cannot forget to do it.
 *
 * Module-scope on purpose: idempotent, and it must be in place before the first
 * request is logged.
 */
setLogContextProvider(() => {
  const ctx = getTenantContext();
  if (!ctx) return undefined;
  // Empty-string orgId (the pre-auth default for unauthenticated endpoints) is
  // NOT an org — leave the field off so the line is routed as unattributed
  // rather than to a tenant named "".
  return { orgId: ctx.orgId || undefined, userId: ctx.userId };
});

/**
 * Resolves the RLS tenant scope for a request. The default reads the CALLER's
 * authenticated identity org (`ctx.identity.orgId`, validated by requireOrgId) — never a
 * route param, which names the QUERIED scope, the wrong tenant for RLS. Services with a different request boundary supply their own resolver (e.g. platform
 * sets the scope pre-auth from an unverified JWT peek so unauthenticated endpoints still
 * get a sane default).
 */
export type TenantScopeResolver = (req: Request) => TenantContext;

/** Default resolver: the authenticated identity's org + super-admin flag, plus
 *  the active-org parent (org → team hierarchy) so downstream side-effects can
 *  reach it without a request, and the caller's user id for the app-layer
 *  predicates that carry a per-user rung. */
const identityScope: TenantScopeResolver = (req) => ({
  // `identity.orgId` is already normalized (trimmed + lowercased) once at
  // resolution in api-core's `getIdentity`, so the GUC set here matches the
  // app-layer WHERE clauses exactly — no ad-hoc re-normalization needed.
  orgId: getContext(req).identity.orgId,
  userId: getContext(req).identity.userId || undefined,
  isSuperAdmin: isSystemAdmin(req),
  parentOrgId: req.user?.parentOrganizationId,
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
 * (500 via next(err)) rather than proceed. Proceeding would run queries with empty RLS GUCs,
 * which under FORCE RLS hide every row and refuse writes — a wiring bug surfacing as a
 * silently empty result instead of an error.
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
