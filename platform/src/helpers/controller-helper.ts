// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Request, Response } from 'express';
import mongoose from 'mongoose';

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

export function isSystemAdmin(req: Request): boolean {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'owner') return false;
  const orgId = req.user?.organizationId?.toLowerCase();
  const orgName = req.user?.organizationName?.toLowerCase();
  return orgId === SYSTEM_ORG_ID || orgName === SYSTEM_ORG_ID;
}

export function isOrgAdmin(req: Request): boolean {
  const role = req.user?.role;
  return (role === 'admin' || role === 'owner') && !isSystemAdmin(req);
}

/**
 * Verify request is authenticated. Sends 401 if not.
 * Acts as a TypeScript type guard — after `if (!requireAuth(req, res)) return;`,
 * `req.user` is narrowed to non-null.
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

// Admin Context

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
  const isOrgAdminUser = isOrgAdmin(req);
  return {
    isSysAdmin,
    isOrgAdmin: isOrgAdminUser,
    adminType: isSysAdmin ? 'system admin' : 'org admin',
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
  if (!ctx.isSysAdmin && !ctx.isOrgAdmin) {
    sendError(res, 403, 'Forbidden: Admin access required');
    return null;
  }
  return ctx;
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
