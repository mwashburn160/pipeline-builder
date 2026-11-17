// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One route, two kinds of caller, each with its OWN gate chain.
 *
 * A few `/organization/:id/*` routes are both a peer-service API (billing's
 * seat/entitlement sync and over-cap reads) and a human surface (the sysadmin
 * seat override, an admin reading their own usage). A bare
 * `isServicePrincipal(req) || …` in the controller admitted ANY service — the
 * plugin, compliance, reporting… — to push an account's seat limit, tier and
 * feature entitlements, and left the sysadmin branch without the
 * `orgs:manage` / step-up gates its sibling mutations (`PATCH /:id/tier`) carry.
 *
 * This middleware branches ONCE, on the caller kind:
 *   - a service principal runs `serviceGates` — in practice
 *     `requireInternalService({ callers })`, the same named-caller gate every
 *     `/internal/*` route uses;
 *   - anyone else runs `userGates` (possibly none, when the controller makes a
 *     row-dependent decision of its own).
 * The real api-core gates run unmodified in each branch; this only picks which.
 */

import { isServicePrincipal } from '@pipeline-builder/api-core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type Gate = RequestHandler | ((req: Request, res: Response, next: NextFunction) => unknown);

function runChain(gates: readonly Gate[], req: Request, res: Response, next: NextFunction): void {
  const run = (i: number): void => {
    if (i === gates.length) return next();
    let result: unknown;
    try {
      result = (gates[i] as (req: Request, res: Response, next: NextFunction) => unknown)(
        req, res, (err?: unknown) => (err ? next(err) : run(i + 1)),
      );
    } catch (err) {
      return next(err);
    }
    // A gate that rejects reaches the error handler, as Express 5 does for a
    // gate mounted directly.
    if (result instanceof Promise) result.catch(next);
  };
  run(0);
}

export function serviceOrUserGates(
  serviceGates: readonly Gate[],
  userGates: readonly Gate[],
): (req: Request, res: Response, next: NextFunction) => void {
  if (serviceGates.length === 0) throw new Error('serviceOrUserGates: a service branch with no gate admits every service');
  return function serviceOrUserGatesRoute(req: Request, res: Response, next: NextFunction): void {
    runChain(isServicePrincipal(req) ? serviceGates : userGates, req, res, next);
  };
}
