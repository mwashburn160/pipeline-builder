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
 * Options for the authenticateToken middleware.
 */
export interface AuthTokenOptions {
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
 * import { authenticateToken } from '@mwashburn160/api-core';
 *
 * // Standard usage — trust JWT exclusively
 * app.get('/protected', authenticateToken, (req, res) => {
 *   res.json({ userId: req.user.sub });
 * });
 *
 * // Allow x-org-id / x-org-name header overrides
 * app.get('/resource', authenticateToken({ allowOrgHeaderOverride: true }), handler);
 * ```
 */
export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void;
export function authenticateToken(
  options?: AuthTokenOptions,
): (req: Request, res: Response, next: NextFunction) => void;
export function authenticateToken(
  reqOrOptions?: Request | AuthTokenOptions,
  res?: Response,
  next?: NextFunction,
): void | ((req: Request, res: Response, next: NextFunction) => void) {
  // If called with (req, res, next), use as direct middleware with default options
  if (reqOrOptions && res && next && 'headers' in reqOrOptions) {
    return _authenticateToken({}, reqOrOptions as Request, res, next);
  }

  // Called with options — return a middleware function
  const options = (reqOrOptions as AuthTokenOptions) || {};
  return (req: Request, resInner: Response, nextInner: NextFunction) => {
    _authenticateToken(options, req, resInner, nextInner);
  };
}

function _authenticateToken(
  options: AuthTokenOptions,
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

    // Reject refresh tokens — they should not be used for API access.
    // Allow tokens with type 'access' or no type field (backwards compat).
    if (decoded.type === 'refresh') {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Refresh tokens cannot be used for API access', ErrorCode.TOKEN_INVALID);
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
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token has expired', ErrorCode.TOKEN_EXPIRED);
    }

    if (err instanceof jwt.JsonWebTokenError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid token', ErrorCode.TOKEN_INVALID);
    }

    logger.error('Token verification failed', {
      error: err instanceof Error ? err.message : String(err),
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

    if (decoded.type !== 'refresh') {
      req.user = decoded;
    }
  } catch {
    // Ignore errors for optional auth
  }

  next();
}

/**
 * Middleware that requires organization membership.
 * Must be used after authenticateToken.
 *
 * @example
 * ```typescript
 * app.get('/org-resource', authenticateToken, requireOrganization, (req, res) => {
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
 * Must be used after authenticateToken.
 *
 * @example
 * ```typescript
 * app.post('/admin-action', authenticateToken, requireAdmin, (req, res) => {
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
export function isSystemOrg(req: Request): boolean {
  if (!req.user) return false;

  const orgId = req.user.organizationId?.toLowerCase();
  const orgName = req.user.organizationName?.toLowerCase();

  return orgId === 'system' || orgName === 'system';
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
