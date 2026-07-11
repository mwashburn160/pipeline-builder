// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isSystemAdmin as apiCoreIsSystemAdmin, isSystemOrgId, sendError } from '@pipeline-builder/api-core';
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
 * Re-exports api-core's privilege gate. The previous local implementation
 * granted sysadmin authority based on org membership (`organizationId` or
 * `organizationName === 'system'`), but that path was a privilege-escalation
 * vector: any user whose active org was named "system" became a platform
 * sysadmin. Only the explicit `req.user.isSuperAdmin === true` claim should
 * confer platform-wide authority. Keeping this re-export so existing
 * `import { isSystemAdmin } from '../helpers/controller-helper.js'` callers
 * keep working.
 */
export const isSystemAdmin = apiCoreIsSystemAdmin;

/**
 * `isOrgAdmin` excludes sysadmins (who get separate handling) AND members
 * of the legacy "system" content-holder org — the latter holds shared
 * sample data and is a content boundary, not a write target.
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

// Effective org access (org → team hierarchy)

/**
 * Lazy bridge to the hierarchy walk. `controller-helper` is imported very
 * widely (every controller pulls `withController`), so we avoid eagerly
 * importing the Mongoose models + platform config it would otherwise drag in —
 * the model chain only loads on the cross-org authorization path.
 */
async function targetIsDescendantOf(activeOrgId: string, targetOrgId: string): Promise<boolean> {
  // Indirect specifier: the runtime import stays lazy (no model/config load at
  // module init) while sidestepping the NodeNext literal-extension rule; the
  // `typeof import(...)` annotation keeps it fully typed.
  const modPath = './org-hierarchy';
  const mod: typeof import('./org-hierarchy.js') = await import(modPath);
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
  if (activeOrgId === targetOrgId) return true;
  return targetIsDescendantOf(activeOrgId, targetOrgId);
}

/**
 * Require effective ADMIN authority over `targetOrgId` (via {@link canAdministerOrg},
 * including the org → team hierarchy). Sends 403 and returns false on failure;
 * returns true otherwise. Mirrors {@link requireSystemAdmin} for the per-org case
 * so controllers can short-circuit with `if (!(await requireOrgAdmin(req, res, id))) return;`.
 */
export async function requireOrgAdmin(req: Request, res: Response, targetOrgId: string): Promise<boolean> {
  if (!(await canAdministerOrg(req, targetOrgId))) {
    sendError(res, 403, 'Forbidden: Admin access required for this organization');
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
  if (activeOrgId === targetOrgId) return true;
  if (!isOrgAdmin(req)) return false;
  return targetIsDescendantOf(activeOrgId, targetOrgId);
}

// Error Handling

export type ErrorMap = Record<string, { status: number; message: string }>;

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
    return sendError(res, mapped.status, mapped.message);
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

// ID Conversion
// `toOrgId` now lives in the mongoose-only `./org-id.js` (no express/api-core
// coupling) so hot paths + service modules can use it without dragging the
// request layer. Re-exported here for the many existing controller-helper importers.
export { toOrgId } from './org-id.js';
