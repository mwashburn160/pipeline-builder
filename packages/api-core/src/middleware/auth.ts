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
  /**
   * Allow x-org-id/x-org-name headers to override the JWT's organization fields.
   *
   * **SECURITY WARNING:** When enabled, a caller can set `x-org-id` to ANY
   * organization ID, effectively impersonating that org. This MUST only be
   * used on routes that are:
   *   1. Internal service-to-service routes (not exposed to end users)
   *   2. Behind network isolation (container network, VPC, etc.)
   *
   * NEVER enable this on user-facing API routes. If unsure, leave it disabled.
   */
  allowOrgHeaderOverride?: boolean;
}

/** JWT auth middleware. Use directly or call with options. */
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

  try {
    const decoded = jwt.verify(parts[1], getJwtSecret()) as JwtPayload;

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

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token has expired', ErrorCode.TOKEN_EXPIRED);
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid token', ErrorCode.TOKEN_INVALID);
    }

    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication failed', ErrorCode.UNAUTHORIZED);
  }
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

/**
 * Requires admin role. Use after requireAuth.
 * Permits users whose per-org role is 'admin' or 'owner'.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
  }

  if (req.user.role !== 'admin' && req.user.role !== 'owner') {
    return sendError(res, HttpStatus.FORBIDDEN, 'Admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
  }

  next();
}

/** Organization ID/name that identifies the system (super-admin) tenant. */
export const SYSTEM_ORG_ID = (process.env.SYSTEM_ORG_ID || 'system').toLowerCase();

/**
 * Check if an orgId or orgName matches the system org.
 * Use this instead of comparing directly against SYSTEM_ORG_ID,
 * because the JWT orgId is a database ID (e.g. MongoDB ObjectId)
 * while SYSTEM_ORG_ID is the well-known name "system".
 */
export function isSystemOrgId(orgId?: string, orgName?: string): boolean {
  return orgId?.toLowerCase() === SYSTEM_ORG_ID || orgName?.toLowerCase() === SYSTEM_ORG_ID;
}

export function isSystemOrg(req: Request): boolean {
  if (!req.user) return false;
  return isSystemOrgId(req.user.organizationId, req.user.organizationName);
}

/**
 * Check if the request is from a system admin.
 * A system admin has per-org role 'admin' or 'owner' in the system organization.
 */
export function isSystemAdmin(req: Request): boolean {
  return (req.user?.role === 'admin' || req.user?.role === 'owner') && isSystemOrg(req);
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
