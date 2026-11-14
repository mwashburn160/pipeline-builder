// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ErrorCode,
  createLogger,
  errorMessage,
  getParam,
  requireAuth,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { frustrationSignalFor } from '../helpers/offers-sentiment.js';

const logger = createLogger('internal-offers');

/** The one caller. Expansion offers are billing's; nobody else needs this. */
const SIGNAL_CALLERS = ['billing'] as const;

/**
 * The FRUSTRATION signal for one org (docs/plans/sales-agent.md Phase 4).
 *
 * `GET /messages/internal/offers/frustration/:orgId` → a boolean and a
 * confidence, derived from the org's own recent support text.
 *
 * **The route exists so the TEXT does not travel.** Billing needs to know
 * whether an account is currently unhappy — a suppression signal no counter can
 * produce — and the only place that is knowable is the service holding the
 * tickets. Giving billing a read on ticket bodies to work it out there would
 * spread the most PII-dense material in the product across a second service for
 * the sake of one boolean.
 *
 * **It cannot be used to widen anything.** The answer's only downstream effect
 * is suppression, so a wrong `true` costs an offer and a wrong `false` costs
 * nothing extra — the asymmetry the D5 boundary is drawn around.
 *
 * NEVER FAILS for a reachable org: an AI outage, an unconfigured provider or an
 * unparseable answer all come back as `degraded: true` with `frustrated: false`,
 * which the caller reads as "no signal". A 500 here would make an AI outage stop
 * expansion offers, which the plan explicitly forbids.
 *
 * NOT tenant-bound to the caller's token org, deliberately: billing's token is
 * scoped to the account it is evaluating, and that IS the org in the path — the
 * handler reads only that org's cases, inside its own tenant scope.
 */
export function createInternalOffersRoutes(): Router {
  const router: Router = Router();

  router.get(
    '/internal/offers/frustration/:orgId',
    requireAuth,
    requireInternalService({ callers: SIGNAL_CALLERS }),
    async (req: Request, res: Response) => {
      const orgId = getParam(req.params, 'orgId');
      if (!orgId) {
        sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
        return;
      }
      try {
        const signal = await frustrationSignalFor(orgId);
        sendSuccess(res, 200, { signal });
      } catch (err) {
        // `frustrationSignalFor` already swallows its own failures, so reaching
        // here means something structural, and it is answered as one. The caller
        // still does not lose an account's turn: billing reads any non-2xx here
        // as NO SIGNAL (`fetchFrustrationSignal` → null), the same as degraded.
        logger.warn('Frustration signal failed structurally', { orgId, error: errorMessage(err) });
        sendError(res, 500, 'Could not derive a signal', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  return router;
}
