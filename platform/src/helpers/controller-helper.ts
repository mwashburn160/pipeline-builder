// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isSystemAdmin, isSystemOrgId, normalizeOrgId, sendError } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';

const logger = createLogger('platform-api');

// Controller Wrapper

/**
 * Wrap a controller handler with unified error handling.
 * Eliminates the need for try-catch in every controller function.
 *
 * @example
 * ```typescript
 * // Before:
 * export async function listOrgs(req: Request, res: Response) {
 *   try { ... } catch (error) { logger.error('[LIST ORGS]', error); sendError(res, 500, 'Error'); }
 * }
 *
 * // After:
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
        handleControllerError(res, err, `[${label}] Error`, errorMap);
      }
    }
  };
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
  if (isSystemOrgId(req.user?.organizationId, req.user?.organizationName)) return false;
  return true;
}

/**
 * Verify request is authenticated. Sends 401 if not.
 * Acts as a TypeScript type guard — after `if (!requireAuth(req, res)) return;`,
 * `req.user` is narrowed to non-null.
 *
 * NOTE: api-core also exports a `requireAuth` (`@pipeline-builder/api-core`)
 * but that is Express middleware with signature `(req, res, next) => void`.
 * The two are deliberately kept separate because they solve different
 * problems:
 *   - Use api-core's `requireAuth` in a router chain to *enforce* auth as
 *     middleware: `router.get('/x', requireAuth, handler)`.
 *   - Use THIS helper inside a controller body to short-circuit + narrow
 *     the type when the middleware was already applied at the route level
 *     but TypeScript can't see the guarantee.
 * If you're tempted to call both, you only need the middleware version.
 */
export function requireAuth(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    sendError(res, 401, 'Unauthorized');
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
    sendError(res, 401, 'Unauthorized');
    return null;
  }
  return userId;
}

/**
 * Verify request is from a system admin. Sends 401/403 if not.
 */
export function requireSystemAdmin(req: Request, res: Response): boolean {
  if (!requireAuth(req, res)) return false;
  if (!isSystemAdmin(req)) {
    sendError(res, 403, 'Forbidden: System admin access required');
    return false;
  }
  return true;
}

/**
 * Verify user belongs to an organization. Sends 400 if not.
 */
export function requireOrgMembership(req: Request, res: Response): string | null {
  if (!requireAuth(req, res)) return null;

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
 *   if (!userId || !orgId) return sendError(res, 401, 'Unauthorized');
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
  adminType: string;
}

/**
 * Get admin context without auth checks (caller must verify auth first).
 */
export function getAdminContext(req: Request): AdminContext {
  const isSuperAdmin = isSystemAdmin(req);
  const isOrgAdminUser = isOrgAdmin(req);
  return {
    isSuperAdmin,
    isOrgAdmin: isOrgAdminUser,
    adminType: isSuperAdmin ? 'system admin' : 'org admin',
  };
}

/**
 * Require admin access and return context. Sends 401/403 on failure and
 * returns null so the caller can short-circuit with `if (!ctx) return;`.
 */
export function requireAdminContext(req: Request, res: Response): AdminContext | null {
  if (!req.user) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }
  const ctx = getAdminContext(req);
  if (!ctx.isSuperAdmin && !ctx.isOrgAdmin) {
    sendError(res, 403, 'Forbidden: Admin access required');
    return null;
  }
  return ctx;
}

/**
 * Who a `members:manage` caller on the `/users` admin routes may act on.
 *
 * The route's `requirePermission('members:manage')` is the capability gate — a
 * custom Role delegating it works, not only the coarse admin/owner role. This
 * adds the tenancy scope, the same rule as {@link canManageOrgScope}: a platform
 * administrator acts fleet-wide; anyone else is confined to their active org
 * (and, where the route looks at another org, its descendant teams).
 */
export interface MemberManagementScope {
  /** Platform administrator — fleet-wide, and alone may change account-level
   *  fields (sign-in details, account deletion, user creation). */
  isSuperAdmin: boolean;
  /** For everyone else: the active org their `members:manage` applies to. */
  orgId?: string;
}

/**
 * Resolve the caller's {@link MemberManagementScope}. Sends 401 (no user) or 403
 * (a non-platform-admin with no active org) and returns null on failure.
 */
export function requireMemberManagementScope(req: Request, res: Response): MemberManagementScope | null {
  if (!req.user) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }
  if (isSystemAdmin(req)) return { isSuperAdmin: true };
  const orgId = req.user.organizationId;
  if (!orgId) {
    sendError(res, 403, 'Forbidden: an active organization is required');
    return null;
  }
  return { isSuperAdmin: false, orgId };
}

// Effective org access (org → team hierarchy)

/**
 * True when the caller's active org and the route's target org are the SAME
 * tenant. Both sides go through api-core's {@link normalizeOrgId} — the one
 * spelling rule the whole fleet uses (quota's `authorizeOrg` and every
 * `getIdentity`-derived `orgId` normalize identically). Comparing the raw
 * strings here meant a mixed-case 24-hex id in the JWT (or in the URL) resolved
 * to the same Mongo document everywhere else while failing this equality — the
 * caller was 403'd out of their OWN org, or fell through to a hierarchy walk
 * that could not match either.
 */
function isSameOrg(activeOrgId: string | undefined, targetOrgId: string): boolean {
  const active = normalizeOrgId(activeOrgId);
  return active !== undefined && active === normalizeOrgId(targetOrgId);
}

/**
 * Lazy bridge to the hierarchy walk. `controller-helper` is imported very
 * widely (every controller pulls `withController`), so we avoid eagerly
 * importing the Mongoose models + platform config it would otherwise drag in —
 * the model chain only loads on the cross-org authorization path. Both ids
 * arrive NORMALIZED (see {@link isSameOrg}) so the walk compares the same
 * spelling the `parentOrgId` strings are stored in.
 */
async function targetIsDescendantOf(activeOrgId: string, targetOrgId: string): Promise<boolean> {
  // Lazy (no model/config load at module init). The specifier MUST be a literal
  // ending in `.js`: Node ESM does not add extensions, so an extensionless or
  // computed './org-hierarchy' throws ERR_MODULE_NOT_FOUND in production while
  // jest's moduleNameMapper hides it (test/esm-import-specifiers.test.ts).
  const mod = await import('./org-hierarchy.js');
  return mod.isAncestorOrg(activeOrgId, targetOrgId);
}

/**
 * Effective ADMIN authorization over a target org, including the org → team
 * hierarchy. A caller may administer `targetOrgId` when they are:
 *   - a platform super admin, OR
 *   - an admin/owner of that exact org (the active-org case), OR
 *   - an admin/owner of one of its **ancestor** orgs (a parent-org admin
 *     manages descendant teams).
 * Members get no implied authority up or down. The same-org case short-circuits
 * before any DB lookup, so flat-org deployments behave exactly as before.
 */
export async function canAdministerOrg(req: Request, targetOrgId: string): Promise<boolean> {
  if (isSystemAdmin(req)) return true;
  if (!isOrgAdmin(req)) return false;
  const activeOrgId = req.user?.organizationId;
  if (!activeOrgId) return false;
  if (isSameOrg(activeOrgId, targetOrgId)) return true;
  return targetIsDescendantOf(normalizeOrgId(activeOrgId)!, normalizeOrgId(targetOrgId) ?? targetOrgId);
}

/**
 * Effective TENANCY scope over a target org for a WRITE whose *capability* was
 * ALREADY authorized at the route by `requirePermission(...)`. Unlike
 * {@link canAdministerOrg} this does NOT re-assert the coarse `isOrgAdmin` role —
 * the fine-grained permission carried in the JWT is the authority, so a custom
 * Role delegating e.g. `members:manage`/`roles:manage` to a non-admin is honored
 * (delegation works instead of being silently 403'd deeper in). It still confines
 * the write to the caller's own scope: a platform super admin (any org), the
 * caller's active org, or a DESCENDANT team of the active org (a parent-org
 * caller manages its teams). The same-org and sysadmin cases short-circuit before
 * any DB lookup, so flat-org deployments do no extra work.
 *
 * Callers on these routes are ONLY reached after the route's `requirePermission`
 * middleware has already 403'd anyone lacking the capability — so a coarse
 * `isOrgAdmin` re-check here would be redundant AND would make fine-grained
 * delegation inert on platform (which is why the old admin-only helper this
 * superseded was removed).
 */
export async function canManageOrgScope(req: Request, targetOrgId: string): Promise<boolean> {
  if (isSystemAdmin(req)) return true;
  const activeOrgId = req.user?.organizationId;
  if (!activeOrgId) return false;
  if (isSameOrg(activeOrgId, targetOrgId)) return true;
  return targetIsDescendantOf(normalizeOrgId(activeOrgId)!, normalizeOrgId(targetOrgId) ?? targetOrgId);
}

/**
 * Require {@link canManageOrgScope} over `targetOrgId` for a permission-gated
 * write. Sends 403 and returns false when the target is outside the caller's
 * tenancy scope; returns true otherwise. This is the tenancy-only successor to
 * {@link requireOrgAdmin} on the member/role routes: the route's
 * `requirePermission(members:manage|roles:manage|...)` is now the sole capability
 * gate, and this enforces only the remaining, non-redundant work — that the
 * `:id` org the caller is acting on is actually within their scope.
 */
export async function requireOrgScope(req: Request, res: Response, targetOrgId: string): Promise<boolean> {
  if (!(await canManageOrgScope(req, targetOrgId))) {
    sendError(res, 403, 'Forbidden: You do not have access to this organization');
    return false;
  }
  return true;
}

/**
 * Effective READ authorization over a target org: a platform super admin, any
 * member of that exact org (a member can view their own org — current
 * behavior), or an admin/owner of an ancestor org (a parent-org admin can view
 * descendant teams). Same-org and sysadmin cases short-circuit before any DB
 * lookup.
 */
export async function canAccessOrg(req: Request, targetOrgId: string): Promise<boolean> {
  if (isSystemAdmin(req)) return true;
  const activeOrgId = req.user?.organizationId;
  if (!activeOrgId) return false;
  if (isSameOrg(activeOrgId, targetOrgId)) return true;
  if (!isOrgAdmin(req)) return false;
  return targetIsDescendantOf(normalizeOrgId(activeOrgId)!, normalizeOrgId(targetOrgId) ?? targetOrgId);
}

// Error Handling

/**
 * Thrown-error message → HTTP response. `code` is optional and only needed when
 * a CLIENT must branch on the refusal (e.g. `MFA_REQUIRED`, which sends the
 * person to enrolment rather than to a sign-out); most refusals are read by a
 * human and need only the message.
 */
export type ErrorMap = Record<string, { status: number; message: string; code?: string }>;

// Mongoose Error Handling

/**
 * Map Mongoose/MongoDB errors to appropriate HTTP responses.
 * Returns null if the error is not a recognized Mongoose error.
 * Internal — callers should use `handleControllerError`.
 */
function mapMongooseError(err: unknown): { status: number; message: string; code: string } | null {
  if (!err || typeof err !== 'object') return null;

  const errObj = err as Record<string, unknown>;

  // Mongoose validation error
  if (errObj.name === 'ValidationError' && errObj.errors) {
    const messages = Object.values(errObj.errors as Record<string, { message: string }>)
      .map((e) => e.message)
      .join(', ');
    return { status: 400, message: messages, code: 'VALIDATION_ERROR' };
  }

  // MongoDB duplicate key error (E11000)
  if (errObj.code === 11000) {
    const keyPattern = errObj.keyPattern as Record<string, unknown> | undefined;
    const field = keyPattern ? Object.keys(keyPattern)[0] : 'field';
    return { status: 409, message: `Duplicate value for ${field}`, code: 'DUPLICATE_KEY' };
  }

  // Mongoose cast error (invalid ObjectId, etc.)
  if (errObj.name === 'CastError') {
    return { status: 400, message: `Invalid ${errObj.path}: ${errObj.value}`, code: 'INVALID_ID' };
  }

  return null;
}

/**
 * Unified controller error handler.
 * Checks transaction error maps, Mongoose errors, ServiceError, then falls back to 500.
 */
export function handleControllerError(
  res: Response,
  err: unknown,
  fallbackMessage: string,
  errorMap?: ErrorMap,
): void {
  const errObj = (err && typeof err === 'object') ? err as Record<string, unknown> : null;

  // 1. Check transaction error map
  if (errorMap && errObj?.message && typeof errObj.message === 'string' && errorMap[errObj.message]) {
    logger.error(fallbackMessage, err);
    const mapped = errorMap[errObj.message];
    return sendError(res, mapped.status, mapped.message, mapped.code);
  }

  // 2. Check Mongoose errors
  const mongoErr = mapMongooseError(err);
  if (mongoErr) {
    logger.error(fallbackMessage, err);
    return sendError(res, mongoErr.status, mongoErr.message, mongoErr.code);
  }

  // 3. Check ServiceError (from plugin/pipeline service clients)
  if (errObj && typeof errObj.statusCode === 'number' && typeof errObj.name === 'string' && errObj.name.includes('ServiceError')) {
    return sendError(res, errObj.statusCode, errObj.message as string, errObj.code as string);
  }

  // 4. Fallback
  logger.error(fallbackMessage, err);
  sendError(res, 500, fallbackMessage);
}
