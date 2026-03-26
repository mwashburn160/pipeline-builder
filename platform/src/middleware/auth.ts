import { sendError } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';
import { User, Organization, UserOrganization } from '../models';
import type { OrgMemberRole } from '../models/user-organization';
import { AccessTokenPayload, UserRole } from '../types';
import {
  verifyAccessToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '../utils';

/** Minimal user shape needed by populateRequestUser (works with lean objects and documents). */
interface UserLike {
  _id: { toString(): string };
  username: string;
  email: string;
  isEmailVerified: boolean;
  lastActiveOrgId?: { toString(): string } | string;
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
  const orgId = activeOrgId || user.lastActiveOrgId?.toString();

  let role: OrgMemberRole = 'member';
  let organizationId: string | undefined;
  let organizationName: string | undefined;

  if (orgId) {
    const membership = await UserOrganization.findOne({ userId, organizationId: orgId, isActive: true }).lean();
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

  if (!authHeader?.startsWith('Bearer ')) {
    return sendError(res, 401, 'Invalid header');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub).select('+tokenVersion').lean();

    if (!user || decoded.tokenVersion !== user.tokenVersion) {
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
 * router.get('/org/:orgId/data', requireAuth, isOrgMember, handler);
 */
export function isOrgMember(req: Request, res: Response, next: NextFunction): void {
  const orgId = req.params.orgId || req.body.organizationId;

  if (!req.user?.organizationId || req.user.organizationId !== orgId) {
    if (req.user?.role !== 'admin' && req.user?.role !== 'owner') {
      return sendError(res, 403, 'You do not belong to this organization');
    }
  }

  next();
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
    if (!req.user || !roles.includes(req.user.role)) {
      return sendError(res, 403, 'Forbidden');
    }
    next();
  };
}
