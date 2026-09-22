// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-assurance gates: minimum AAL / max auth age for a person's session,
 * and the org-admin MFA policy.
 */

import type { Request, Response, NextFunction } from 'express';
import { tagRouteGate, type OrgAdminAssuranceMachines } from './route-table.js';
import { HttpStatus } from '../constants/http-status.js';
import { serviceIdentity } from '../services/service-keys.js';
import { type AssuranceLevel, type JwtPayload } from '../types/common.js';
import { ErrorCode } from '../types/error-codes.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { sendError } from '../utils/response.js';
import { recordAuthzDenial } from './permission-gates.js';
/**
 * Whether a set of verified claims speaks for a PERSON's own session — the only
 * kind of credential an assurance level can be asserted about.
 *
 * Excludes all three machine shapes: an internal service principal, an org
 * service account, and any exchanged access key (`token_use: 'api_key'`, i.e. a
 * PAT or a service-account key), each of which authenticates a program holding a
 * secret rather than a person presenting factors.
 */
export function isHumanPrincipal(claims: Pick<JwtPayload, 'principalType' | 'token_use'> | undefined): boolean {
  return claims?.principalType === 'user' && claims.token_use === 'access';
}

/** What an assurance gate demands. */
export interface AssuranceOptions {
  minAssurance: AssuranceLevel;
  maxAge?: number;
  /**
   * A NAMED carve-out for requests that cannot possibly satisfy the level and
   * must still be served — today only one exists: the bootstrap-administrator
   * window, where a fresh install's single admin has no factor yet and the setup
   * calls that create the install's automation credential would otherwise be
   * unreachable (see platform's `isBootstrapSetupRequest`).
   *
   * It is deliberately shaped as `{ reason, when }` rather than a bare predicate:
   * the reason is counted (`assurance_exempted_total{reason}`) and published on
   * the route table as `assuranceExempt`, so an exemption cannot be added without
   * showing up in the generated table a reviewer reads. The gate keeps its
   * `minAssurance` tag either way — the route still requires MFA-grade for
   * everyone the carve-out does not name.
   */
  exempt?: { reason: string; when: (req: Request) => boolean };
}

/**
 * Standalone assurance gate, for a service whose own `requireAuth` is not
 * api-core's (platform's is its own, because it reads Mongo). Compose it AFTER
 * authentication: `router.get('/x', requireAuth, requireAssurance({ minAssurance: 2 }), h)`.
 *
 * Identical rules and identical refusals to `requireAuth({ minAssurance })` —
 * that option simply calls the same check inline, so there is one implementation
 * of "is this session MFA-grade" in the codebase.
 */
export function requireAssurance(options: AssuranceOptions) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    // A named exemption is checked AFTER authentication and before the level, so
    // it can never admit an unauthenticated caller, and it is counted every time
    // it fires — an exemption nobody can see is how a gate quietly stops being one.
    if (options.exempt?.when(req) === true) {
      emitCounter('assurance_exempted_total', { service: serviceIdentity(), reason: options.exempt.reason });
      return next();
    }
    if (refuseForAssurance(options, req.user as JwtPayload, req, res)) return;
    next();
  }, {
    kind: 'assurance',
    minAssurance: options.minAssurance,
    ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
    ...(options.exempt ? { exempt: options.exempt.reason } : {}),
  });
}

/**
 * Handler-level twin of {@link requireAssurance}, for a route where only SOME
 * requests must be MFA-grade — e.g. a policy route on which TIGHTENING a setting
 * stays open to a single-factor session (so an admin without MFA can adopt it)
 * but LOOSENING it does not. Same rules and the same three refusals. Returns
 * true when the request was REFUSED (a response has been sent).
 */
export function refuseWeakSession(req: Request, res: Response, options: AssuranceOptions): boolean {
  if (!req.user) {
    sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    return true;
  }
  return refuseForAssurance(options, req.user as JwtPayload, req, res);
}

/** What {@link requireOrgAdminAssurance} demands of a route. */
export interface OrgAdminAssuranceOptions {
  /** What a machine credential (PAT, service account, machine session) meets on
   *  this route while the policy is on — see {@link OrgAdminAssuranceMachines}.
   *  Required, so every route states its decision rather than inheriting one. */
  machines: OrgAdminAssuranceMachines;
}

/** `details.reason` on a refusal by {@link requireOrgAdminAssurance}, so the UI
 *  can say it is the ORG's policy asking, not the route's own requirement. */
export const ORG_ADMIN_MFA_REASON = 'org_admin_policy';

/**
 * The refusal {@link requireOrgAdminAssurance} would send for these claims, or
 * `undefined` when the request may proceed. Exported so a handler whose policy
 * applies to only PART of a route (e.g. `generate-token`, where opening a new
 * machine credential is gated but renewing an existing one is not) applies the
 * exact same rule rather than a copy of it.
 */
export function orgAdminAssuranceRefusal(
  claims: JwtPayload | undefined,
  options: OrgAdminAssuranceOptions,
): { status: number; code: ErrorCode; message: string; reason: 'machine_principal' | 'weak_session' } | undefined {
  // The claim is only ever `2`, and only when the policy is on (see JwtPayload).
  if (!claims || claims.org_admin_aal !== 2) return undefined;
  if (!isHumanPrincipal(claims)) {
    if (options.machines === 'allow') return undefined;
    return {
      status: HttpStatus.FORBIDDEN,
      code: ErrorCode.HUMAN_SESSION_REQUIRED,
      reason: 'machine_principal',
      message: 'Your organization requires two-factor authentication for this action — API keys and service accounts cannot perform it',
    };
  }
  if ((claims.aal ?? 1) >= 2) return undefined;
  return {
    status: HttpStatus.UNAUTHORIZED,
    code: ErrorCode.MFA_REQUIRED,
    reason: 'weak_session',
    message: 'Your organization requires two-factor authentication for administrative actions — sign in again with a passkey or an authenticator code',
  };
}

/**
 * Apply {@link orgAdminAssuranceRefusal} and send its refusal. Returns true when
 * the request was REFUSED (a response has been sent). For handler-level use;
 * routes use {@link requireOrgAdminAssurance}.
 */
export function refuseForOrgAdminAssurance(req: Request, res: Response, options: OrgAdminAssuranceOptions): boolean {
  const refusal = orgAdminAssuranceRefusal(req.user as JwtPayload | undefined, options);
  if (!refusal) return false;
  emitCounter('mfa_enforcement_refused_total', { service: serviceIdentity(), reason: `org_admin_${refusal.reason}` });
  recordAuthzDenial(req, 'assurance:org-admin');
  sendError(res, refusal.status, refusal.message, refusal.code, { reason: ORG_ADMIN_MFA_REASON });
  return true;
}

/**
 * The org policy "administrative actions require MFA" (`adminActionsRequireMfa`).
 *
 * Unlike {@link requireAssurance}, the requirement is the ORG's choice, not the
 * route's: the gate reads the `org_admin_aal` claim, set at token issue from the
 * active org's policy (strictest across its ancestors), so a service that cannot
 * read the org document still enforces it. With the policy off the gate is a
 * no-op; with it on, a single-factor session is refused 401 `MFA_REQUIRED`
 * (with `details.reason: 'org_admin_policy'`) — the same code the client already
 * turns into "enrol a factor / sign in with it", never a sign-out.
 *
 * `machines` is decided per route (see {@link OrgAdminAssuranceMachines}): the
 * policy is about how strongly a PERSON's session was opened, so automation that
 * legitimately drives a route keeps working (`allow`), while a route that mints
 * a further credential refuses machines outright (`refuse`, 403
 * `HUMAN_SESSION_REQUIRED` — the same refusal `requireAssurance` gives them).
 */
export function requireOrgAdminAssurance(options: OrgAdminAssuranceOptions) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    if (refuseForOrgAdminAssurance(req, res, options)) return;
    next();
  }, { kind: 'orgAdminAssurance', machines: options.machines });
}

/**
 * Enforce `minAssurance` / `maxAge` on a verified token. Returns true when the
 * request was REFUSED (a response has been sent).
 *
 * Three distinct refusals, because the client's next move differs for each:
 * a machine must stop (403), a weak session must gain a factor (401
 * `MFA_REQUIRED` → enrolment, never a sign-out), and a stale one must simply
 * authenticate again (401 `REAUTH_REQUIRED`).
 */
export function refuseForAssurance(
  options: AssuranceOptions,
  decoded: JwtPayload,
  req: Request,
  res: Response,
): boolean {
  const minAssurance = options.minAssurance;
  const refuse = (reason: string, status: number, message: string, code: ErrorCode): true => {
    emitCounter('mfa_enforcement_refused_total', { service: serviceIdentity(), reason });
    recordAuthzDenial(req, `assurance:${minAssurance}`);
    sendError(res, status, message, code);
    return true;
  };

  if (!isHumanPrincipal(decoded)) {
    return refuse(
      'machine_principal', HttpStatus.FORBIDDEN,
      'This action requires a person signed in with two-factor authentication — API keys and service accounts cannot perform it',
      ErrorCode.HUMAN_SESSION_REQUIRED,
    );
  }
  if ((decoded.aal ?? 1) < minAssurance) {
    return refuse(
      'weak_session', HttpStatus.UNAUTHORIZED,
      'This action requires two-factor authentication — sign in again with a passkey or an authenticator code',
      ErrorCode.MFA_REQUIRED,
    );
  }
  if (options.maxAge !== undefined) {
    const authTime = decoded.auth_time;
    // No `auth_time` is not "recent enough by default" — `hasValidIdentityClaims`
    // already requires it on a user token, so an absent one means a token this
    // gate cannot reason about. Fail closed.
    if (typeof authTime !== 'number' || Math.floor(Date.now() / 1000) - authTime > options.maxAge) {
      return refuse(
        'stale_session', HttpStatus.UNAUTHORIZED,
        'This action requires a recent sign-in — please authenticate again',
        ErrorCode.REAUTH_REQUIRED,
      );
    }
  }
  return false;
}

