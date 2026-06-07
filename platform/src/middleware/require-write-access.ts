// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Blocks state-changing requests when the caller is operating under a
 * read-only impersonation token. Lets a sysadmin "view as user X" for
 * support work without any chance of destructive actions landing under
 * that identity.
 *
 * Whitelisted methods: GET, HEAD, OPTIONS.
 *
 * Applied globally after `requireAuth` populates `req.user`. Endpoints
 * that legitimately need a state change while impersonated (none
 * today) would have to opt out individually.
 */

import { sendError } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';

export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Shared message + code for a blocked write under read-only impersonation. */
export const IMPERSONATION_READ_ONLY_MESSAGE =
  'Write requests are disabled during read-only impersonation. Stop impersonating to make changes.';
export const IMPERSONATION_READ_ONLY_CODE = 'IMPERSONATION_READ_ONLY';

/**
 * Pure decision shared by BOTH read-only-impersonation gates: the shipped
 * global guard in `index.ts` (which JWT-peeks pre-auth) and the per-route
 * `requireWriteAccess` middleware (which reads `req.user` post-auth). Keeping
 * one predicate means the two can't drift. A write (non read-method) is blocked
 * iff the caller is under a read-only impersonation token.
 */
export function isWriteBlockedByImpersonation(method: string, impersonationReadOnly: boolean | undefined): boolean {
  return impersonationReadOnly === true && !READ_METHODS.has(method);
}

export function requireWriteAccess(req: Request, res: Response, next: NextFunction): void {
  if (isWriteBlockedByImpersonation(req.method, req.user?.impersonationReadOnly)) {
    sendError(res, 403, IMPERSONATION_READ_ONLY_MESSAGE, IMPERSONATION_READ_ONLY_CODE);
    return;
  }
  next();
}
