import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpStatus } from '../constants/http-status';
import { JwtPayload } from '../types/common';
import { ErrorCode } from '../types/error-codes';
import { getHeaderString } from '../utils/headers';
import { createLogger } from '../utils/logger';
import { sendError } from '../utils/response';

const logger = createLogger('auth-middleware');

/** Cached JWT secret, loaded lazily to avoid crashing at import time. */
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

export interface RequireAuthOptions {
  /** Allow x-org-id/x-org-name headers to override JWT org fields (for service-to-service calls). */
  allowOrgHeaderOverride?: boolean;
}

/** JWT auth middleware. Use directly or call with options: requireAuth({ allowOrgHeaderOverride: true }) */
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
  if (reqOrOptions && res && next && 'headers' in reqOrOptions) {
    return _requireAuth({}, reqOrOptions as Request, res, next);
  }

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

    if (decoded.type !== 'access') {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Only access tokens can be used for API requests', ErrorCode.TOKEN_INVALID);
    }

    if (!decoded.sub || !decoded.role) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token missing required fields', ErrorCode.TOKEN_INVALID);
    }

    req.user = { ...decoded };

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

/** Attaches user if token is present but doesn't require authentication. */
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
    logger.debug('Optional auth token verification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  next();
}

/** Requires organization membership. Use after requireAuth. */
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

/** Requires admin role. Use after requireAuth. */
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

/** Organization ID/name that identifies the system (super-admin) tenant. */
export const SYSTEM_ORG_ID = (process.env.SYSTEM_ORG_ID || 'system').toLowerCase();

export function isSystemOrg(req: Request): boolean {
  if (!req.user) return false;

  const orgId = req.user.organizationId?.toLowerCase();
  const orgName = req.user.organizationName?.toLowerCase();

  return orgId === SYSTEM_ORG_ID || orgName === SYSTEM_ORG_ID;
}

export function isSystemAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && isSystemOrg(req);
}

/** Requires system admin (admin role + system organization). */
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

/** Only system admins can set access to 'public'; everyone else gets 'private'. */
export function resolveAccessModifier(req: Request, requested: string | undefined): 'public' | 'private' {
  if (requested === 'public' && isSystemAdmin(req)) {
    return 'public';
  }
  return 'private';
}
