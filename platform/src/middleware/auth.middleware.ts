/**
 * @module middleware/auth
 * @description Authentication and authorization middleware for protecting routes.
 * Handles JWT token validation, refresh token verification, and role-based access control.
 */

import { Request, Response, NextFunction } from 'express';
import { User, Organization } from '../models';
import { UserRole } from '../types';
import {
  sendUnauthorized,
  sendForbidden,
  verifyAccessToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '../utils';

/** Minimal user shape needed by populateRequestUser (works with lean objects and documents). */
interface UserLike {
  _id: { toString(): string };
  username: string;
  email: string;
  role: 'user' | 'admin';
  isEmailVerified: boolean;
  organizationId?: { toString(): string } | string;
  tokenVersion: number;
}

/**
 * Populate the request.user object with user details from the database.
 * Includes organization name lookup if user belongs to an organization.
 *
 * @param req - Express request object to populate
 * @param user - User document from database
 * @internal
 */
async function populateRequestUser(req: Request, user: UserLike): Promise<void> {
  let organizationName: string | undefined;

  // Look up organization name if user has an organizationId
  if (user.organizationId) {
    const org = await Organization.findById(user.organizationId).select('name').lean();
    organizationName = org?.name;
  }

  (req.user as any) = {
    sub: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isAdmin: user.role === 'admin',
    isEmailVerified: user.isEmailVerified,
    organizationId: user.organizationId?.toString(),
    organizationName,
    tokenVersion: user.tokenVersion,
  };
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
 * router.get('/protected', isAuthenticated, handler);
 */
export async function isAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return sendUnauthorized(res, 'Invalid header');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub).select('+tokenVersion').lean();

    if (!user || decoded.tokenVersion !== user.tokenVersion) {
      return sendUnauthorized(res, 'Session invalid');
    }

    await populateRequestUser(req, user);
    next();
  } catch {
    // Token verification failed - return unauthorized without exposing error details
    return sendUnauthorized(res, 'Token invalid');
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
    return sendUnauthorized(res, 'Token required');
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded?.sub || decoded.tokenVersion === undefined) {
      return sendUnauthorized(res, 'Token invalid');
    }

    const hash = hashRefreshToken(refreshToken);
    const user = await User.findById(decoded.sub).select('+refreshToken +tokenVersion');

    if (!user || user.refreshToken !== hash || user.tokenVersion !== decoded.tokenVersion) {
      return sendUnauthorized(res, 'Session invalid');
    }

    await populateRequestUser(req, user);
    next();
  } catch {
    // Token verification failed - return unauthorized without exposing error details
    return sendUnauthorized(res, 'Token invalid');
  }
}

/**
 * Middleware to verify user belongs to the specified organization.
 * Checks orgId from route params or request body against user's organizationId.
 * System admins bypass this check.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * @returns 403 if user doesn't belong to the organization and is not an admin
 *
 * @example
 * router.get('/org/:orgId/data', isAuthenticated, isOrgMember, handler);
 */
export function isOrgMember(req: Request, res: Response, next: NextFunction): void {
  const orgId = req.params.orgId || req.body.organizationId;

  if (!req.user?.organizationId || req.user.organizationId !== orgId) {
    if (req.user?.role !== 'admin') {
      return sendForbidden(res, 'You do not belong to this organization');
    }
  }

  next();
}

/**
 * Middleware factory for role-based access control.
 * Creates middleware that restricts access to users with specified roles.
 *
 * @param roles - Allowed user roles ('user' | 'admin')
 * @returns Express middleware function
 * @returns 403 if user's role is not in the allowed list
 *
 * @example
 * router.delete('/admin-only', isAuthenticated, authorize('admin'), handler);
 * router.get('/members', isAuthenticated, authorize('user', 'admin'), handler);
 */
export function authorize(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      return sendForbidden(res, 'Forbidden');
    }
    next();
  };
}
