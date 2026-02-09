/**
 * @module controllers/helpers
 * @description Shared helper functions for controller authentication,
 * authorization, error handling, and request parsing.
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { logger, sendError } from '../utils';

// ============================================================================
// Auth Helpers
// ============================================================================

export function isSystemAdmin(req: Request): boolean {
  if (req.user?.role !== 'admin') return false;
  const orgId = req.user?.organizationId?.toLowerCase();
  const orgName = req.user?.organizationName?.toLowerCase();
  return orgId === 'system' || orgName === 'system';
}

export function isOrgAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && !isSystemAdmin(req);
}

/**
 * Verify request is authenticated. Sends 401 if not.
 */
export function requireAuth(req: Request, res: Response): boolean {
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

// ============================================================================
// Admin Context
// ============================================================================

export interface AdminContext {
  isSysAdmin: boolean;
  isOrgAdmin: boolean;
  adminType: string;
}

/**
 * Get admin context without auth checks (caller must verify auth first).
 */
export function getAdminContext(req: Request): AdminContext {
  const isSysAdmin = isSystemAdmin(req);
  return {
    isSysAdmin,
    isOrgAdmin: isOrgAdmin(req),
    adminType: isSysAdmin ? 'system admin' : 'org admin',
  };
}

/**
 * Require admin access and return context. Sends 401/403 if not authorized.
 */
export function requireAdminContext(req: Request, res: Response): AdminContext | null {
  if (!req.user) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }

  const isSysAdmin = isSystemAdmin(req);
  const isOrgAdminUser = isOrgAdmin(req);

  if (!isSysAdmin && !isOrgAdminUser) {
    sendError(res, 403, 'Forbidden: Admin access required');
    return null;
  }

  return {
    isSysAdmin,
    isOrgAdmin: isOrgAdminUser,
    adminType: isSysAdmin ? 'system admin' : 'org admin',
  };
}

// ============================================================================
// Auth Context (for service proxy controllers)
// ============================================================================

export interface AuthContext {
  userId: string;
  orgId: string;
  token: string;
}

/**
 * Extract and validate full auth context (user, org, token) from request.
 */
export function getAuthContext(req: Request, res: Response, action: string): AuthContext | null {
  if (!req.user) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }

  const orgId = req.user.organizationId;
  if (!orgId) {
    sendError(res, 400, `You must belong to an organization to ${action}`);
    return null;
  }

  const token = extractToken(req);
  if (!token) {
    sendError(res, 401, 'Authentication token is required');
    return null;
  }

  return { userId: req.user.sub, orgId, token };
}

// ============================================================================
// Token Extraction
// ============================================================================

/**
 * Extract JWT token from Authorization header.
 */
export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

// ============================================================================
// Error Handling
// ============================================================================

export type ErrorMap = Record<string, { status: number; message: string }>;

/**
 * Handle transaction errors by mapping known error messages to HTTP responses.
 */
export function handleTransactionError(res: Response, err: any, errorMap: ErrorMap, fallbackMessage: string): void {
  logger.error(fallbackMessage, err);
  const error = errorMap[err.message] || { status: 500, message: fallbackMessage };
  sendError(res, error.status, error.message);
}

// ============================================================================
// ID Conversion
// ============================================================================

/**
 * Convert a string org ID to ObjectId when valid.
 * Organization._id is Mixed type to support both string IDs ('system')
 * and ObjectId values. findById won't auto-cast strings to ObjectId
 * for Mixed fields, so we must do it explicitly.
 */
export function toOrgId(id: string | string[]): string | mongoose.Types.ObjectId {
  const idStr = Array.isArray(id) ? id[0] : id;
  return mongoose.Types.ObjectId.isValid(idStr) && idStr.length === 24
    ? new mongoose.Types.ObjectId(idStr)
    : idStr;
}
