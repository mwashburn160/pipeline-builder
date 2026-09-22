// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin-ecosystem governance gate (docs/plans/plugin-ecosystem.md §3.0,
 * §5a, §5a.1).
 *
 * Only the system org manages or approves the ecosystem. A route that exercises
 * a system-org-only permission (`plugins:moderate`, `publishers:verify`) must
 * therefore check three things, and {@link requireEcosystemPermission} composes
 * them so no route can forget one:
 *
 *  1. {@link requireSystemOrg} — the caller's ACTIVE org is the system org. A
 *     token minted in a tenant org is refused even for the same person (and even
 *     for a superadmin: they switch to the system org to act on the ecosystem,
 *     so every governance decision is recorded with the system org's id).
 *  2. the permission itself (`requirePermission`, any-of);
 *  3. an MFA-grade session (`requireAssurance({ minAssurance: 2 })`), which also
 *     refuses every machine credential.
 *
 * The route-coverage governance check (`findSystemOrgGuardViolations` in
 * `testing/route-coverage.ts`) fails any route that gates on a system-org-only
 * permission without 1 and 3, so a hand-rolled chain cannot slip through.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isSystemOrgId, recordAuthzDenial, requireAssurance, requirePermission } from './auth.js';
import { tagRouteGate } from './route-table.js';
import { HttpStatus } from '../constants/http-status.js';
import { ErrorCode } from '../types/error-codes.js';
import { isSystemOrgOnlyPermission, type Permission } from '../types/permissions.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { sendError } from '../utils/response.js';

/** Whether the request's ACTIVE org (the token's `organizationId`) is the system
 *  org. Compared by id only — an org merely NAMED "system" never qualifies. */
export function isSystemOrgRequest(req: Request): boolean {
  return isSystemOrgId(req.user?.organizationId);
}

/**
 * Require that the caller's active org is the system org. Compose after
 * `requireAuth`. Refusals are 403 `SYSTEM_ORG_REQUIRED`, counted
 * (`system_org_guard_refused_total`) and audited through the shared
 * `authz.denied` sink (`required: 'system-org'`).
 */
export const requireSystemOrg = tagRouteGate(function requireSystemOrg(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
  }
  if (isSystemOrgRequest(req)) return next();
  emitCounter('system_org_guard_refused_total', { principal: req.user.principalType ?? 'unknown' });
  recordAuthzDenial(req, 'system-org');
  return sendError(
    res, HttpStatus.FORBIDDEN,
    'This action is reserved for the system organization — switch to it to manage the plugin ecosystem',
    ErrorCode.SYSTEM_ORG_REQUIRED,
  );
}, { kind: 'systemOrg' });

/**
 * THE gate for an ecosystem-governance route: system org + (any of) the given
 * system-org-only permission(s) + an MFA-grade human session. Returns the chain
 * as an array, which Express flattens:
 *
 * ```ts
 * router.post('/requests/:id/approve', requireAuth, requireEcosystemPermission('plugins:moderate'),
 *   requireStepUp, audited('plugin.request.approve'), handler);
 * ```
 *
 * Throws at route-definition time when handed a permission that is NOT
 * system-org-only — a tenant permission behind this gate would be unreachable
 * for every tenant, which is always a wiring mistake.
 */
export function requireEcosystemPermission(...permissions: Permission[]): RequestHandler[] {
  if (permissions.length === 0) throw new Error('requireEcosystemPermission needs at least one permission');
  const tenant = permissions.filter((p) => !isSystemOrgOnlyPermission(p));
  if (tenant.length > 0) {
    throw new Error(`requireEcosystemPermission only takes system-org-only permissions; got ${tenant.join(', ')}`);
  }
  return [
    requireSystemOrg,
    requirePermission(...permissions),
    requireAssurance({ minAssurance: 2 }),
  ] as RequestHandler[];
}
