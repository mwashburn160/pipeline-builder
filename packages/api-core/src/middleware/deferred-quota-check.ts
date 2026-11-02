// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * A quota check armed at MOUNT time and run by `requireAuth` once the caller is
 * verified.
 *
 * Why deferred: the apiCalls meter + check mount ONCE per service, ahead of its
 * whole user surface (api-server `apiCallsQuota`), but authentication is per
 * route — routers mix public, user and machine routes under one prefix. At mount
 * time there is no verified org to check yet, and checking a header-derived or
 * peeked one would hand a forged token a victim org's usage in the 429 body. So
 * the mount only ARMS the check here, and `requireAuth` (api-core's, and
 * platform's own) runs it at its single post-verification choke point, after
 * the request identity has been re-derived from the JWT. A route that never
 * authenticates never runs it — there is no org to bill.
 *
 * At most once per request: running it empties the slot, so a second
 * `requireAuth` in the same chain is a plain `next()`.
 */
const SLOT = 'deferredQuotaCheck';

/** Arm `check` to run after this request authenticates. */
export function armDeferredQuotaCheck(res: Response, check: RequestHandler): void {
  res.locals[SLOT] = check;
}

/** `requireAuth`'s `next()`: run the armed quota check, if any, then continue. */
export function runDeferredQuotaCheck(req: Request, res: Response, next: NextFunction): void {
  const check = res.locals?.[SLOT] as RequestHandler | undefined;
  if (!check) return next();
  delete res.locals[SLOT];
  void check(req, res, next);
}
