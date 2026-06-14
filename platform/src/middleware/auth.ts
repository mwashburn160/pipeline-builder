// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, isSystemAdmin, sendError } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import { toOrgId } from '../helpers/controller-helper.js';
import { User, Organization, UserOrganization } from '../models/index.js';
import type { OrgMemberRole } from '../models/user-organization.js';
import type { AccessTokenPayload, UserRole } from '../types/index.js';
import {
  verifyAccessToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '../utils/index.js';

/** Minimal user shape needed by populateRequestUser (works with lean objects and documents). */
interface UserLike {
  _id: { toString(): string };
  username: string;
  email: string;
  isEmailVerified: boolean;
  isSuperAdmin?: boolean;
  lastActiveOrgId?: string;
  tokenVersion: number;
}

/**
 * Populate the request.user object with user details from the database.
 * Queries UserOrganization for the active org membership to resolve role and org name.
 *
 * @param req - Express request object to populate
 * @param user - User document from database
 * @param activeOrgId - Optional org ID override (e.g. from JWT)
 * @internal
 */
async function populateRequestUser(req: Request, user: UserLike, activeOrgId?: string): Promise<void> {
  const userId = user._id.toString();
  const orgId = activeOrgId || user.lastActiveOrgId;

  let role: OrgMemberRole = 'member';
  let organizationId: string | undefined;
  let organizationName: string | undefined;

  if (orgId) {
    const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId), isActive: true }).lean();
    if (membership) {
      role = membership.role as OrgMemberRole;
      organizationId = orgId;
      const org = await Organization.findById(orgId).select('name').lean();
      organizationName = org?.name;
    }
  }

  // Fall back to first membership if no active org found
  if (!organizationId) {
    const first = await UserOrganization.findOne({ userId, isActive: true }).sort({ joinedAt: 1 }).lean();
    if (first) {
      role = first.role as OrgMemberRole;
      organizationId = first.organizationId.toString();
      const org = await Organization.findById(organizationId).select('name').lean();
      organizationName = org?.name;
    }
  }

  const payload: AccessTokenPayload = {
    type: 'access',
    sub: userId,
    username: user.username,
    email: user.email,
    role,
    isAdmin: role === 'admin' || role === 'owner',
    // Propagate the sysadmin claim. Missing this here silently turned every
    // sysadmin into a regular user as soon as this middleware ran — every
    // /admin/* and audit route 403'd because `req.user.isSuperAdmin` was
    // undefined. The User document MUST be loaded with `+isSuperAdmin` for
    // this to resolve to true (see the .select() call in requireAuth below).
    isSuperAdmin: user.isSuperAdmin === true,
    isEmailVerified: user.isEmailVerified,
    organizationId,
    organizationName,
    tokenVersion: user.tokenVersion,
  };
  req.user = payload;
}

/**
 * Middleware to authenticate requests using JWT access tokens.
 * Validates the Bearer token from the Authorization header and populates req.user.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * @returns 401 if token is missing, invalid, or session is invalidated
 *
 * @example
 * router.get('/protected', requireAuth, handler);
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  // Distinguish missing header (no Authorization at all) from malformed
  // (present but not a Bearer token). The client UI distinguishes "log in"
  // (TOKEN_MISSING) from "session is broken" (TOKEN_INVALID).
  if (!authHeader) {
    return sendError(res, 401, 'Authorization header required', ErrorCode.TOKEN_MISSING);
  }
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Malformed authorization header', ErrorCode.TOKEN_INVALID);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);

    // Only access tokens may authenticate Bearer requests. Refresh, step-up,
    // and impersonation tokens are minted via the same JWT secret but carry
    // a non-'access' `type` claim; accepting them here would let those
    // short-lived/special-purpose tokens act as a session bearer.
    if (decoded.type !== 'access') {
      return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
    }

    // `+isSuperAdmin` — both fields are `select: false` on the schema. Without
    // them, populateRequestUser silently builds a non-sysadmin req.user even
    // though the JWT (and the User doc) say otherwise.
    const user = await User.findById(decoded.sub).select('+tokenVersion +isSuperAdmin').lean();

    if (!user || decoded.tokenVersion !== user.tokenVersion) {
      return sendError(res, 401, 'Session invalid');
    }

    // Scope the request to the org the ACCESS TOKEN was minted for, not the
    // user's `lastActiveOrgId` in the DB. The two diverge whenever the user
    // switches active org in another session/tab: honoring lastActiveOrgId
    // would silently run this request (and its role check) against the wrong
    // org. populateRequestUser re-verifies the membership for this org and
    // falls back to a valid membership if the user no longer belongs to it.
    await populateRequestUser(req, user, decoded.organizationId);
    next();
  } catch {
    // Token verification failed - return unauthorized without exposing error details
    return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
  }
}

/**
 * Internal service-to-service auth.
 *
 * Verifies a service JWT minted by `signServiceToken` (api-core) — the same
 * mechanism `getServiceAuthHeader` uses for cross-service calls. Accepts
 * tokens whose `sub` starts with `service:` and rejects everything else,
 * so user tokens can't hit internal endpoints by accident.
 *
 * Used by the audit-events ingest endpoint so the plugin build worker
 * (and any future internal emitter) can write into MongoDB without
 * needing a real platform user identity. JWT signature is verified
 * against the same secret as user tokens; the platform/api-core split
 * shares `JWT_SECRET`.
 */
export async function requireServiceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return sendError(res, 401, 'Authorization header required', ErrorCode.TOKEN_MISSING);
  }
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Malformed authorization header', ErrorCode.TOKEN_INVALID);
  }
  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    // Same gate as `requireAuth`: only `type: 'access'` may bear requests.
    // Service tokens are minted with `type: 'access'` too — see `signServiceToken`.
    if (decoded.type !== 'access') {
      return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
    }
    if (!decoded.sub?.startsWith('service:')) {
      return sendError(res, 403, 'Service auth required');
    }
    // Hydrate req.user enough that downstream handlers can read sub /
    // organizationId without re-decoding the token.
    req.user = decoded;
    next();
  } catch {
    return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
  }
}

/**
 * Middleware to validate refresh tokens from request body.
 * Used for token refresh endpoints to issue new access tokens.
 *
 * @param req - Express request object (expects refreshToken in body)
 * @param res - Express response object
 * @param next - Express next function
 * @returns 401 if refresh token is missing, invalid, or session is invalidated
 *
 * @example
 * router.post('/refresh', isValidRefreshToken, refreshHandler);
 */
export async function isValidRefreshToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return sendError(res, 401, 'Token required');
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded?.sub || decoded.tokenVersion === undefined) {
      return sendError(res, 401, 'Token invalid');
    }

    const hash = hashRefreshToken(refreshToken);
    const user = await User.findById(decoded.sub).select('+refreshToken +tokenVersion');

    if (!user || user.refreshToken !== hash || user.tokenVersion !== decoded.tokenVersion) {
      return sendError(res, 401, 'Session invalid');
    }

    await populateRequestUser(req, user);
    next();
  } catch {
    // Token verification failed - return unauthorized without exposing error details
    return sendError(res, 401, 'Token invalid');
  }
}

/**
 * Middleware factory for role-based access control.
 * Creates middleware that restricts access to users with specified roles.
 *
 * @param roles - Allowed user roles ('owner' | 'admin' | 'member')
 * @returns Express middleware function
 * @returns 403 if user's role is not in the allowed list
 *
 * @example
 * router.delete('/admin-only', requireAuth, requireRole('admin'), handler);
 * router.get('/members', requireAuth, requireRole('user', 'admin'), handler);
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // System admins are platform superusers — they satisfy any org-role gate.
    // Controllers still apply their own per-org checks (canAdministerOrg /
    // canAccessOrg), and `requireStepUp` still applies on destructive routes,
    // so this only removes the role-list inconsistency that otherwise 403s a
    // sysadmin from admin/owner actions (e.g. creating an organization).
    if (req.user && (isSystemAdmin(req) || roles.includes(req.user.role))) {
      return next();
    }
    return sendError(res, 403, 'Forbidden');
  };
}

/**
 * Route-level guard for **platform** (system) administrators only — `isSuperAdmin`,
 * not org role. Use this on routes whose controller already calls the
 * `requireSystemAdmin` *helper*, so the route reads accurately (org admins do
 * NOT qualify) and is rejected one layer earlier (defense in depth). Distinct
 * from `requireRole('admin','owner')`, which lets org admins/owners through.
 */
export function requireSystemAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user && isSystemAdmin(req)) {
    return next();
  }
  return sendError(res, 403, 'Forbidden: system administrator access required');
}
