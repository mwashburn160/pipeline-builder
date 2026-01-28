import { Request, Response, NextFunction } from 'express';
import { User } from '../models';
import { UserRole } from '../types';
import {
  sendUnauthorized,
  sendForbidden,
  verifyAccessToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '../utils';

/**
 * Populate request user from validated token
 */
function populateRequestUser(req: Request, user: any): void {
  req.user = {
    sub: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isAdmin: user.role === 'admin',
    isEmailVerified: user.isEmailVerified,
    organizationId: user.organizationId?.toString(),
    tokenVersion: user.tokenVersion,
  };
}

/**
 * Authenticate request using access token
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

    populateRequestUser(req, user);
    next();
  } catch {
    return sendUnauthorized(res, 'Token invalid');
  }
}

/**
 * Validate refresh token from request body
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

    populateRequestUser(req, user);
    next();
  } catch {
    return sendUnauthorized(res, 'Token invalid');
  }
}

/**
 * Check if user belongs to specified organization
 */
export function isOrgMember(req: Request, res: Response, next: NextFunction): void {
  const orgId = req.params.orgId || req.body.organizationId;

  if (!req.user?.organizationId || req.user.organizationId !== orgId) {
    if (!req.user?.isAdmin) {
      return sendForbidden(res, 'You do not belong to this organization');
    }
  }

  next();
}

/**
 * Require specific roles to access route
 */
export function authorize(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      return sendForbidden(res, 'Forbidden');
    }
    next();
  };
}
