// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Restrict a route to a real, interactive browser/CLI session opened by the
 * person themselves.
 *
 * Registering or removing a passkey — or enrolling, disabling or re-keying an
 * authenticator app — mints (or destroys) PERSISTENT credential material, so it
 * must not be reachable by anything that merely inherited the user's authority:
 *   - an access key (`pb_pat_…` / `pb_sa_…`) exchanged for a token — no `sid`,
 *     `token_use: 'api_key'`;
 *   - a scoped machine credential (`reporting:ingest` and friends);
 *   - an impersonation token, read-only or not — an operator viewing an account
 *     must never be able to leave a credential behind in it. (The global
 *     read-only gate in `index.ts` already blocks the writes; this also covers
 *     a non-read-only impersonation session, should one ever exist.)
 *   - a service principal, which is not a person at all.
 *
 * Runs AFTER `requireAuth`, so `req.user` is verified. Fails closed: anything
 * that isn't recognisably a person's own session is refused.
 */

import { isServiceAccountPrincipal, isServicePrincipal, sendError } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import type { AccessTokenPayload } from '../types/index.js';

const INTERACTIVE_SESSION_REQUIRED_CODE = 'INTERACTIVE_SESSION_REQUIRED';

export function requireInteractiveSession(req: Request, res: Response, next: NextFunction): void {
  const user = req.user as AccessTokenPayload | undefined;
  const isPersonalSession = !!user
    && !!user.sid
    && !user.scope
    && !user.impersonatorId
    && user.token_use !== 'api_key'
    && !isServicePrincipal(req)
    && !isServiceAccountPrincipal(req);

  if (!isPersonalSession) {
    sendError(
      res, 403,
      'Sign in on this device to manage sign-in credentials — API keys and impersonated sessions can\'t.',
      INTERACTIVE_SESSION_REQUIRED_CODE,
    );
    return;
  }
  next();
}
