/**
 * @module middleware/auth
 * @description JWT authentication middleware for API microservices.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpStatus } from '../constants/http-status';
import { JwtPayload } from '../types/common';
import { ErrorCode } from '../types/error-codes';
import { getHeaderString } from '../utils/headers';
import { createLogger } from '../utils/logger';
import { sendError } from '../utils/response';

const logger = createLogger('auth-middleware');

/**
 * Cached JWT secret, loaded lazily on first use.
 * This avoids crashing at import time for consumers that never call auth functions
 * (e.g. CLI tools that only import types or utilities from api-core).
 */
let _jwtSecret: string | undefined;

function getJwtSecret(): string {
  if (!_jwtSecret) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      logger.error('JWT_SECRET environment variable is not set');
      throw new Error('JWT_SECRET environment variable is required');
    }
    _jwtSecret = secret;
  }
  return _jwtSecret;
}

/**
 * Options for the requireAuth middleware.
 */
export interface RequireAuthOptions {
  /**
   * Allow `x-org-id` and `x-org-name` headers to override
   * the organizationId / organizationName from the JWT.
   *
   * Useful for service-to-service calls where the JWT belongs
   * to a service account but the request is on behalf of a
   * specific organization.
   *
   * @default false
   */
  allowOrgHeaderOverride?: boolean;
}

/**
 * Authentication middleware that validates JWT tokens.
 *
 * Extracts the Bearer token from the Authorization header,
 * verifies it, and attaches the decoded payload to `req.user`.
 *
 * @param options - Optional configuration (or can be used directly as middleware)
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * import { requireAuth } from '@mwashburn160/api-core';
 *
 * // Standard usage — trust JWT exclusively
 * app.get('/protected', requireAuth, (req, res) => {
 *   res.json({ userId: req.user.sub });
 * });
 *
 * // Allow x-org-id / x-org-name header overrides
 * app.get('/resource', requireAuth({ allowOrgHeaderOverride: true }), handler);
 * ```
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void;
export function requireAuth(
  options?: RequireAuthOptions,
): (req: Request, res: Response, next: NextFunction) => void;
export function requireAuth(
  reqOrOptions?: Request | RequireAuthOptions,
  res?: Response,
  next?: NextFunction,
): void | ((req: Request, res: Response, next: NextFunction) => void) {
  // If called with (req, res, next), use as direct middleware with default options
  if (reqOrOptions && res && next && 'headers' in reqOrOptions) {
    return _requireAuth({}, reqOrOptions as Request, res, next);
  }

  // Called with options — return a middleware function
  const options = (reqOrOptions as RequireAuthOptions) || {};
  return (req: Request, resInner: Response, nextInner: NextFunction) => {
    _requireAuth(options, req, resInner, nextInner);
  };
}

function _requireAuth(
  options: RequireAuthOptions,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authorization header required', ErrorCode.TOKEN_MISSING);
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid authorization format. Use: Bearer <token>', ErrorCode.TOKEN_INVALID);
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;

    // Only accept access tokens for API requests.
    if (decoded.type !== 'access') {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Only access tokens can be used for API requests', ErrorCode.TOKEN_INVALID);
    }

    // Validate required token fields
    if (!decoded.sub || !decoded.role) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token missing required fields', ErrorCode.TOKEN_INVALID);
    }

    // Attach user to request
    req.user = { ...decoded };

    // Apply header overrides if enabled
    if (options.allowOrgHeaderOverride) {
      const headerOrgId = getHeaderString(req.headers['x-org-id']);
      const headerOrgName = getHeaderString(req.headers['x-org-name']);
      if (headerOrgId) req.user.organizationId = headerOrgId;
      if (headerOrgName) req.user.organizationName = headerOrgName;
    }

    logger.debug('Token verified successfully', {
      userId: decoded.sub,
      orgId: req.user.organizationId,
    });

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token has expired', ErrorCode.TOKEN_EXPIRED);
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid token', ErrorCode.TOKEN_INVALID);
    }

    logger.error('Token verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication failed', ErrorCode.UNAUTHORIZED);
  }
}

/**
 * Optional authentication middleware.
 * Does not require authentication but will attach user if token is present.
 *
 * @example
 * ```typescript
 * app.get('/public', optionalAuth, (req, res) => {
 *   if (req.user) {
 *     // User is authenticated
 *   } else {
 *     // Anonymous access
 *   }
 * });
 * ```
 */
export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return next();
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;

    if (decoded.type === 'access') {
      req.user = decoded;
    }
  } catch (error) {
    // Optional auth — don't block the request, but log for debugging
    logger.debug('Optional auth token verification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  next();
}

/**
 * Middleware that requires organization membership.
 * Must be used after requireAuth.
 *
 * @example
 * ```typescript
 * app.get('/org-resource', requireAuth, requireOrganization, (req, res) => {
 *   // req.user.organizationId is guaranteed to exist
 * });
 * ```
 */
export function requireOrganization(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
  }

  if (!req.user.organizationId) {
    return sendError(res, HttpStatus.BAD_REQUEST, 'Organization membership required', ErrorCode.ORG_MISMATCH);
  }

  next();
}

/**
 * Middleware that requires admin role.
 * Must be used after requireAuth.
 *
 * @example
 * ```typescript
 * app.post('/admin-action', requireAuth, requireAdmin, (req, res) => {
 *   // User is guaranteed to be admin
 * });
 * ```
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
  }

  if (req.user.role !== 'admin') {
    return sendError(res, HttpStatus.FORBIDDEN, 'Admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
  }

  next();
}

/**
 * Check if user belongs to system organization.
 *
 * @param req - Express request with user attached
 * @returns True if user is in system organization
 */
/** Organization ID/name that identifies the system (super-admin) tenant. */
export const SYSTEM_ORG_ID = (process.env.SYSTEM_ORG_ID || 'system').toLowerCase();

export function isSystemOrg(req: Request): boolean {
  if (!req.user) return false;

  const orgId = req.user.organizationId?.toLowerCase();
  const orgName = req.user.organizationName?.toLowerCase();

  return orgId === SYSTEM_ORG_ID || orgName === SYSTEM_ORG_ID;
}

/**
 * Check if user is a system admin.
 *
 * @param req - Express request with user attached
 * @returns True if user is admin in system organization
 */
export function isSystemAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && isSystemOrg(req);
}

/**
 * Middleware that requires system admin (admin role + system organization).
 *
 * Returns 403 if the user is not a system admin. Use this for routes
 * that should only be accessible to administrators of the system org.
 *
 * @example
 * ```typescript
 * router.put('/:id', requireAuth, requireSystemAdmin, handler);
 * ```
 */
export function requireSystemAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isSystemAdmin(req)) {
    return sendError(
      res, HttpStatus.FORBIDDEN,
      'Access denied. Only system administrators can perform this action.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }
  next();
}

/**
 * Resolve the effective access modifier for a resource.
 * Only system admins can set access to 'public'; non-system-admins are forced to 'private'.
 *
 * @param req - Express request with user attached
 * @param requested - The requested access modifier value
 * @returns 'public' if system admin and requested public, otherwise 'private'
 */
export function resolveAccessModifier(req: Request, requested: string | undefined): 'public' | 'private' {
  if (requested === 'public' && isSystemAdmin(req)) {
    return 'public';
  }
  return 'private';
}
