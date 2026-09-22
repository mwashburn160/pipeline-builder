// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authorization gates — permissions, system admin, features — and the
 * `authz.denied` audit sink they report refusals to.
 */

import type { Request, Response, NextFunction } from 'express';
import { tagRouteGate } from './route-table.js';
import { HttpStatus } from '../constants/http-status.js';
import { serviceIdentity } from '../services/service-keys.js';
import { ErrorCode } from '../types/error-codes.js';
import { type Permission, hasPermission } from '../types/permissions.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { sendError } from '../utils/response.js';
import { isServicePrincipal, serviceNameOf } from './service-tokens.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('auth-middleware');
/**
 * Whether the request's user holds `permission`. Superadmins implicitly hold
 * every permission. Reads the resolved `permissions` claim (set at token issue,
 * or re-derived per request by the platform).
 */
export function userHasPermission(req: Request, permission: Permission): boolean {
  return hasPermission(req.user?.permissions, permission, req.user?.isSuperAdmin);
}

/**
 * Context passed to a registered authorization-denial auditor when a
 * state-changing request is rejected by `requirePermission` /
 * `requireSystemAdmin`.
 */
export interface AuthzDenialInfo {
  /** The denied user's id (`sub`), if authenticated. */
  actorId?: string;
  actorEmail?: string;
  /** The user's active org at denial time. */
  orgId?: string;
  /** HTTP method + path of the rejected request. */
  method: string;
  path: string;
  /** What was required: the missing permission(s), or 'system-admin'. */
  required: string;
}

/**
 * Optional sink for denied-authorization events. Left unset by default so
 * api-core stays decoupled from any audit transport — a service registers one
 * at boot (typically forwarding to its `RemoteAuditClient` as an
 * `authz.denied` event, or, on platform, to the local `audit()` helper).
 * MUST be best-effort: it is invoked inside the request path, so it must never
 * throw or block (the gate wraps the call in try/catch regardless).
 */
let authzDenialAuditor: ((info: AuthzDenialInfo) => void) | undefined;

/**
 * Register (or clear, with `undefined`) the process-wide authorization-denial
 * auditor. Idempotent; the last registration wins.
 */
export function setAuthzDenialAuditor(fn: ((info: AuthzDenialInfo) => void) | undefined): void {
  authzDenialAuditor = fn;
}

/**
 * Emit a denial event, best-effort. Only fires for state-changing (non-GET,
 * non-HEAD/OPTIONS) requests — a rejected GET is low-signal probing noise and
 * would amplify audit volume under a scan. Never throws.
 *
 * The permission gates here call it themselves. Export it for data-driven checks
 * a route makes inline (cross-org access, service-only endpoints), so those 403s
 * reach the same `authz.denied` trail. `required` names what was missing.
 */
export function recordAuthzDenial(req: Request, required: string): void {
  const auditor = authzDenialAuditor;
  if (!auditor) return;
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  try {
    auditor({
      actorId: req.user?.sub,
      actorEmail: req.user?.email,
      orgId: req.user?.organizationId,
      method,
      // Strip the query string — a denied request may carry a token/secret as a
      // query param, and this path is persisted verbatim into the audit log.
      path: (req.originalUrl || req.url).split('?')[0],
      required,
    });
  } catch {
    // Best-effort — a broken auditor must never break the auth gate.
  }
}

/** The shared gate preamble: answer 401 and return false when unauthenticated. */
function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (req.user) return true;
  sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
  return false;
}

/** Audit + answer a permission refusal (`missing` defaults to every required permission). */
function denyPermission(req: Request, res: Response, permissions: Permission[], mode: 'or' | 'and', missing: Permission[] = permissions): void {
  recordAuthzDenial(req, permissions.join(` ${mode} `));
  sendError(
    res, HttpStatus.FORBIDDEN,
    `Missing required permission: ${missing.join(` ${mode} `)}`,
    ErrorCode.INSUFFICIENT_PERMISSIONS,
  );
}

/**
 * Requires that the user hold AT LEAST ONE of the given permissions (or be a
 * superadmin). Use after requireAuth. Mirrors `requireRole`'s any-of semantics;
 * pass a single permission for a specific action, or several when any one of
 * them should grant access.
 */
export function requirePermission(...permissions: Permission[]) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!requireUser(req, res)) return;
    // userHasPermission → hasPermission already grants superadmins every
    // permission, so this single check covers both the superadmin bypass and
    // the any-of membership test without re-inlining either.
    if (permissions.some((p) => userHasPermission(req, p))) return next();
    denyPermission(req, res, permissions, 'or');
  }, { kind: 'permission', mode: 'any', permissions });
}

/**
 * Requires that the user hold EVERY one of the given permissions (or be a
 * superadmin) — the AND counterpart to `requirePermission`'s any-of. Use for a
 * sensitive action that legitimately demands two distinct capabilities at once
 * (e.g. a cross-surface operation), so the guarantee is explicit rather than
 * approximated by chaining two `requirePermission` gates. Superadmins bypass
 * (they implicitly hold every permission).
 */
export function requireAllPermissions(...permissions: Permission[]) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!requireUser(req, res)) return;
    const missing = permissions.filter((p) => !userHasPermission(req, p));
    if (missing.length === 0) return next();
    denyPermission(req, res, permissions, 'and', missing);
  }, { kind: 'permission', mode: 'all', permissions });
}

/**
 * Like {@link requirePermission} (any-of) but ALSO admits an internal service
 * principal (`principalType: 'service'`). For READ endpoints that BOTH
 * interactive users — who must hold one of the `:read` capabilities — AND
 * service-to-service callers legitimately hit; service tokens carry no
 * permission claims (they're least-privilege `role:member`), so a plain
 * `requirePermission` would wrongly 403 them. Superadmins pass via
 * `userHasPermission`'s implicit-all. Use only where a service caller is a known,
 * intended consumer of the route (verify the callers); prefer plain
 * `requirePermission` for purely user-facing reads.
 */
export function requirePermissionOrService(...permissions: Permission[]) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!requireUser(req, res)) return;
    if (isServicePrincipal(req) || permissions.some((p) => userHasPermission(req, p))) return next();
    denyPermission(req, res, permissions, 'or');
  }, { kind: 'permission', mode: 'any', permissions, allowService: true });
}

/**
 * Gate an endpoint to internal service-to-service callers only (a
 * `principalType: 'service'` principal minted via {@link signServiceToken} / `getServiceAuthHeader`).
 * Rejects any user token. For NON-user-facing endpoints — entity-event ingest,
 * auto-subscribe, and similar peer-service hooks — that a browser must never
 * reach. Compose after `requireAuth` so `req.user` is populated.
 */
export function requireServicePrincipal(req: Request, res: Response, next: NextFunction): void {
  if (!isServicePrincipal(req)) {
    // 403 (not 400) — this is an authorization refusal; status must match the
    // INSUFFICIENT_PERMISSIONS code and the sibling gates (requirePermission, etc.).
    return sendError(res, HttpStatus.FORBIDDEN, 'Internal service calls only', ErrorCode.INSUFFICIENT_PERMISSIONS);
  }
  next();
}
tagRouteGate(requireServicePrincipal, { kind: 'servicePrincipal' });

/**
 * THE gate for an INTERNAL route — the one every `/internal/*` path, the
 * quota usage counters, the entity-event ingest and the audit ingest go through.
 *
 * Two rules, both fail-closed:
 *
 *  1. **No user token, ever.** Not a member's, not a superadmin's, not a
 *     service-account key's. An internal route is a peer-service API surface, so
 *     "a sufficiently privileged human" is not an acceptable caller — that
 *     equivalence is exactly how a browser-reachable path becomes a tenant
 *     boundary bug. `requireServicePrincipal` already refused users; this also
 *     closes the `|| isSystemAdmin(req)` escape hatches that had grown around
 *     the individual internal routes.
 *  2. **Only the NAMED callers.** `callers` lists the services that legitimately
 *     call this route, and the name is cryptographically bound to the signing
 *     key (`services/service-keys.ts`), so this is an identity check rather than
 *     a claim check. It is the same allow-list the mesh policy names, at the
 *     layer that also holds in docker compose, where there is no mesh at all —
 *     the Istio `AuthorizationPolicy` is defence in depth on top, never the
 *     enforcement.
 *
 * Compose after `requireAuth` so `req.user` is populated. Refusals are counted
 * (`internal_route_refused_total`) and audited through the shared `authz.denied`
 * sink.
 */
export function requireInternalService(options: { callers: readonly string[] }) {
  const allowed = new Set(options.callers);
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    const refuse = (reason: 'unauthenticated' | 'user_token' | 'wrong_caller'): void => {
      emitCounter('internal_route_refused_total', {
        service: serviceIdentity(),
        route: req.route?.path ? `${req.method} ${req.baseUrl}${req.route.path}` : `${req.method} ${(req.originalUrl || req.url).split('?')[0]}`,
        reason,
        caller: serviceNameOf(req.user) ?? 'none',
      });
      recordAuthzDenial(req, `internal-service (${options.callers.join(', ')})`);
      if (reason === 'unauthenticated') {
        return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
      }
      logger.warn('Refused an internal route', { reason, path: (req.originalUrl || req.url).split('?')[0], caller: serviceNameOf(req.user) });
      return sendError(res, HttpStatus.FORBIDDEN, 'Internal service calls only', ErrorCode.INSUFFICIENT_PERMISSIONS);
    };

    if (!req.user) return refuse('unauthenticated');
    if (!isServicePrincipal(req)) return refuse('user_token');
    const caller = serviceNameOf(req.user);
    if (!caller || !allowed.has(caller)) return refuse('wrong_caller');
    next();
  }, { kind: 'servicePrincipal' }, { kind: 'internalService', callers: [...options.callers] });
}

/**
 * Check if the request is from a system admin.
 *
 * Authority is granted solely by the user-level `isSuperAdmin` flag carried
 * in the JWT — never by membership in the well-known 'system' org, which would
 * conflate a Pipeline Builder operator with a customer tenant and let any
 * write that created a 'system'-named org quietly grant cross-org authority. The `system` org still exists as a *content holder* for shared
 * sample data; it confers no privilege.
 */
export function isSystemAdmin(req: Request): boolean {
  return req.user?.isSuperAdmin === true;
}

/**
 * Whether the request's token carries a specific capability `scope` (e.g.
 * `'reporting:ingest'`). Used to gate endpoints that accept a narrow machine
 * identity — a normal interactive user token has no `scope` and returns false.
 */
export function hasScope(req: Request, scope: string): boolean {
  return req.user?.scope === scope;
}

/** Requires a system admin — granted solely by the `isSuperAdmin` token claim.
 *  Use after requireAuth. */
export function requireSystemAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isSystemAdmin(req)) {
    recordAuthzDenial(req, 'system-admin');
    return sendError(
      res, HttpStatus.FORBIDDEN,
      'Access denied. Only system administrators can perform this action.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }
  next();
}
tagRouteGate(requireSystemAdmin, { kind: 'systemAdmin' });

/**
 * Require a specific feature flag. Use after requireAuth.
 * Checks the `features` array in the JWT payload (set at token issuance).
 * Sysadmins (isSuperAdmin) bypass — they always have every feature.
 */
export function requireFeature(feature: string) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!requireUser(req, res)) return;

    // Sysadmins get all features; the `features` array on their token is
    // populated with every flag at issuance time but the bypass here keeps
    // the rule explicit and survives a token issued before a new feature
    // flag was added.
    if (req.user.isSuperAdmin === true) return next();

    if (!req.user.features?.includes(feature)) {
      // Route feature-gate denials through the same audit sink as
      // requirePermission / requireSystemAdmin so a probe for an
      // unentitled capability leaves a trail (state-changing methods only).
      recordAuthzDenial(req, `feature:${feature}`);
      return sendError(
        res, HttpStatus.FORBIDDEN,
        `This feature requires a higher plan (${feature})`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    next();
  }, { kind: 'feature', feature });
}

