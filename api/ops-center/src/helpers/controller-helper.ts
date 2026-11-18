// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isSystemAdmin, isSystemOrgId, recordAuthzDenial, sendError } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';

const logger = createLogger('ops-center');

/*
 * Controller helpers — the JWT-only subset of platform's helpers/controller-helper.ts
 * the moved controllers use (no Mongo-backed org-scope checks live here).
 */

// Controller Wrapper

/**
 * Wrap a controller handler with unified error handling: a thrown error is
 * mapped through `errorMap` (or answered 500) by `handleControllerError`, so
 * handlers need no try/catch of their own.
 *
 * @example
 * ```typescript
 * export const listOrgs = withController('List organizations', async (req, res) => { ... });
 * ```
 */
export function withController(
  label: string,
  handler: (req: Request, res: Response) => Promise<void>,
  errorMap?: ErrorMap,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        // A thrown refusal the map answers 403 is an authorization denial like
        // any gate's — record it on the same trail, named by its error code.
        const code = err instanceof Error ? err.message : undefined;
        if (code && errorMap?.[code]?.status === 403) recordAuthzDenial(req, code);
        handleControllerError(res, err, `[${label}] Error`, errorMap);
      }
    }
  };
}

/**
 * Answer an inline authorization refusal with 403 AND record it on the
 * `authz.denied` trail — the data-driven checks a controller makes itself (a
 * target outside the caller's scope, a privilege only an owner holds) are
 * denials exactly like a route gate's. `rule` names what was required
 * (`recordAuthzDenial` skips GET/HEAD/OPTIONS itself, so reads add no noise).
 * Returns nothing so a caller can `return forbid(...)`.
 */
export function forbid(req: Request, res: Response, rule: string, message: string, code?: string): void {
  recordAuthzDenial(req, rule);
  if (code) sendError(res, 403, message, code);
  else sendError(res, 403, message);
}

// Auth Helpers

/**
 * `isOrgAdmin` excludes sysadmins (who get separate handling) AND members of
 * the "system" content-holder org — that org is a live, load-bearing tenant
 * holding the shared sample/template content every org reads, so it is a
 * content boundary, not a write target.
 */
export function isOrgAdmin(req: Request): boolean {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'owner') return false;
  if (isSystemAdmin(req)) return false;
  // BY ID ONLY — see `hasPlatformImpersonationAuthority`. Matching the NAME
  // here fails in the opposite direction: an org that renames itself to
  // "system" would stop being administrable by its own admins.
  if (isSystemOrgId(req.user?.organizationId)) return false;
  return true;
}

/** The one 401 message the controller guards answer with. */
const AUTH_REQUIRED = 'Authentication required';

/**
 * Inside a controller body: 401 when there is no authenticated user, and a
 * TypeScript type guard otherwise — after `if (!ensureAuthenticated(req, res))
 * return;`, `req.user` is non-null. The route's `requireAuth` middleware is
 * what enforces authentication; this narrows the type the middleware already
 * guaranteed (and still refuses if a route was wired without it).
 */
export function ensureAuthenticated(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    sendError(res, 401, AUTH_REQUIRED);
    return false;
  }
  return true;
}

/**
 * Verify request is authenticated and return user ID. Sends 401 if not.
 */
export function requireAuthUserId(req: Request, res: Response): string | null {
  const userId = req.user?.sub;
  if (!userId) {
    sendError(res, 401, AUTH_REQUIRED);
    return null;
  }
  return userId;
}

/**
 * Verify user belongs to an organization. Sends 400 if not.
 */
export function requireOrgMembership(req: Request, res: Response): string | null {
  if (!ensureAuthenticated(req, res)) return null;

  const orgId = req.user!.organizationId;
  if (!orgId) {
    sendError(res, 400, 'You must belong to an organization');
    return null;
  }
  return orgId;
}

/**
 * Combined auth + org-membership guard. Returns `{ userId, orgId }` when
 * both are present, or `null` after writing a 401/400 response. Lets
 * controllers replace the recurring three-liner:
 *
 *   const userId = req.user?.sub;
 *   const orgId  = req.user?.organizationId;
 *   if (!userId || !orgId) return sendError(res, 401, 'Authentication required');
 *
 * with `const ctx = requireAuthContext(req, res); if (!ctx) return;`.
 *
 * Status codes match the underlying helpers: 401 for missing user
 * (via requireAuthUserId), 400 for missing org (via requireOrgMembership).
 */
export function requireAuthContext(
  req: Request,
  res: Response,
): { userId: string; orgId: string } | null {
  const userId = requireAuthUserId(req, res);
  if (!userId) return null;
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return null;
  return { userId, orgId };
}

// Admin Context

export interface AdminContext {
  isSuperAdmin: boolean;
  isOrgAdmin: boolean;
}

/**
 * Get admin context without auth checks (caller must verify auth first).
 */
export function getAdminContext(req: Request): AdminContext {
  return { isSuperAdmin: isSystemAdmin(req), isOrgAdmin: isOrgAdmin(req) };
}

/**
 * Thrown-error message → HTTP response. `code` is optional and only needed when
 * a CLIENT must branch on the refusal (e.g. `MFA_REQUIRED`, which sends the
 * person to enrolment rather than to a sign-out); most refusals are read by a
 * human and need only the message.
 */
export type ErrorMap = Record<string, { status: number; message: string; code?: string }>;

/**
 * Unified controller error handler.
 * Checks the error map, ServiceError, then falls back to 500.
 */
export function handleControllerError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
  errorMap?: ErrorMap,
): void {
  const errObj = (err && typeof err === 'object') ? err as Record<string, unknown> : null;

  // 1. A mapped domain refusal. It is an answer, not a failure: a 4xx is the
  // caller's problem (debug), a mapped 5xx is still worth a warning.
  if (errorMap && errObj?.message && typeof errObj.message === 'string' && errorMap[errObj.message]) {
    const mapped = errorMap[errObj.message];
    if (mapped.status >= 500) logger.warn(fallbackMessage, { code: errObj.message, status: mapped.status });
    else logger.debug(fallbackMessage, { code: errObj.message, status: mapped.status });
    return sendError(res, mapped.status, mapped.message, mapped.code);
  }

  // 3. Check ServiceError (from plugin/pipeline service clients)
  if (errObj && typeof errObj.statusCode === 'number' && typeof errObj.name === 'string' && errObj.name.includes('ServiceError')) {
    return sendError(res, errObj.statusCode, errObj.message as string, errObj.code as string);
  }

  // 4. Fallback
  logger.error(fallbackMessage, err);
  sendError(res, 500, fallbackMessage);
}
