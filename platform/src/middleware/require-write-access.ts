// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only impersonation fence: state-changing requests under a read-only
 * impersonation token are refused, so a sysadmin can "view as user X" for
 * support work without any chance of destructive actions landing under that
 * identity.
 *
 * Whitelisted methods: GET, HEAD, OPTIONS.
 *
 * Enforced twice: pre-auth by the global `app.use` in index.ts (an unverified
 * JWT peek, so a refusal costs no DB work) and post-verification in
 * `requireAuth` (middleware/auth.ts), which is the authoritative check.
 */

import { recordAuthzDenial, sendError } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Shared message + code for a blocked write under read-only impersonation. */
export const IMPERSONATION_READ_ONLY_MESSAGE =
  'Write requests are disabled during read-only impersonation. Stop impersonating to make changes.';
export const IMPERSONATION_READ_ONLY_CODE = 'IMPERSONATION_READ_ONLY';
/** The `required` an `authz.denied` row carries for this refusal. */
export const IMPERSONATION_READ_ONLY_REQUIRED = 'impersonation-read-only';

/**
 * Pure decision shared by BOTH read-only-impersonation gates: the global guard
 * in `index.ts` (which JWT-peeks pre-auth) and `requireAuth` (which checks the
 * verified claims). Keeping
 * one predicate means the two can't drift. A write (non read-method) is blocked
 * iff the caller is under a read-only impersonation token.
 */
export function isWriteBlockedByImpersonation(method: string, impersonationReadOnly: boolean | undefined): boolean {
  return impersonationReadOnly === true && !READ_METHODS.has(method);
}

/**
 * Refuse a write under read-only impersonation: record it on the `authz.denied`
 * trail (the same `required` name api-core's own read-only gate records) and
 * answer 403. Shared by both gates so neither can refuse silently.
 */
export function denyReadOnlyImpersonationWrite(req: Request, res: Response): void {
  recordAuthzDenial(req, IMPERSONATION_READ_ONLY_REQUIRED);
  sendError(res, 403, IMPERSONATION_READ_ONLY_MESSAGE, IMPERSONATION_READ_ONLY_CODE);
}
