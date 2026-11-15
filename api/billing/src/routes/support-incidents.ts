// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One-time support incidents: the CONCESSION door into a support case.
 *
 * WHAT AN INCIDENT IS FOR. Support is sold per contact, and an org holding zero
 * contacts cannot open a case. An incident is the second door: it serves the
 * customer who needs one answer and has no support subscription, and it is
 * granted as a CONCESSION rather than sold. There is deliberately no purchase
 * path — monthly support cancels freely, so any incident priced above $19.99 is
 * dominated by just buying a month, and anything below it loses money.
 *
 * WHY THE CONSUME IS A ROUTE AND NOT A SYNCED NUMBER. The balance could have
 * been pushed onto the root org alongside `seats` and `supportContacts`, which
 * is the shape those two use. That was the first design and it is worse here:
 * the balance changes on every grant AND every spend, so the synced copy is
 * stale exactly when it matters, and the message service would then have to
 * read-then-write anyway. ONE atomic "consume if you can" avoids the race and
 * the staleness together — and it costs a hop only on the rare path, because
 * the caller asks only when the org has no contact seat to open against.
 */

import {
  ErrorCode,
  SYSTEM_ORG_ID,
  actorId,
  audited,
  createLogger,
  errorMessage,
  getParam,
  recordAudit,
  requireAuth,
  requireInternalService,
  requirePermission,
  requireSystemOrgPermission,
  requireStepUp,
  sendBadRequest,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { resolveAccountRootOrgId } from '../helpers/root-org-guard.js';
import {
  INCIDENT_KEY_PATTERN,
  MAX_INCIDENT_GRANT,
  consumeSupportIncident,
  grantSupportIncidents,
  refundSupportIncident,
  supportIncidentsRemaining,
} from '../helpers/support-incidents.js';

const logger = createLogger('support-incidents-routes');

/** The one service allowed to spend an incident. */
const CONSUME_CALLERS = ['message'] as const;

/**
 * The ROOT org whose subscription holds `orgId`'s incident balance. The balance
 * is account-scoped like every other subscription field, but cases are opened —
 * and grants are typed — against whichever org the person is in, so a team id
 * must resolve to its root. Answers 503 (and returns null) when the hierarchy
 * can't be proven: spending, refunding or granting against the WRONG org is
 * worse than a refusal the caller can see and retry.
 */
async function accountOrgOr503(res: Response, orgId: string): Promise<string | null> {
  try {
    return await resolveAccountRootOrgId(orgId);
  } catch (err) {
    logger.error('Support-incident account lookup failed', { orgId, error: errorMessage(err) });
    sendError(res, 503, 'Could not resolve the organization\'s account; try again', ErrorCode.SERVICE_UNAVAILABLE);
    return null;
  }
}

/**
 * The caller's idempotency key from the body, or null after answering 400. The
 * consume and refund both REQUIRE one: without it a consume whose reply was
 * lost cannot be safely re-sent, and a refund cannot tell a spend that happened
 * from one that did not.
 */
function incidentKeyOr400(req: Request, res: Response): string | null {
  const key = (req.body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  if (typeof key !== 'string' || !INCIDENT_KEY_PATTERN.test(key)) {
    sendBadRequest(res, 'idempotencyKey must be 8-128 characters of [A-Za-z0-9_-]', ErrorCode.VALIDATION_ERROR);
    return null;
  }
  return key;
}

/**
 * NO `allowOrgHeaderOverride` on any route here, deliberately. The internal and
 * admin routes name their org in the PATH, and the one account route reads the
 * caller's OWN balance, so none of them has an active org for a sys-admin's
 * `x-org-id` to replace.
 */
export function createSupportIncidentRoutes(): Router {
  const router: Router = Router();

  /**
   * GET /billing/support-incidents
   *
   * The caller's ACCOUNT incident balance: `{ balance, accountOrgId }`. A team
   * member reads the root's balance, because that is what a case they open
   * would spend.
   *
   * `messages:read`, not `billing:read`: the people who need this number are the
   * ones who open support cases, and most of them hold no billing permission. It
   * discloses one count of concessions, no money and no plan.
   */
  router.get(
    '/support-incidents',
    requireAuth,
    requirePermission('messages:read') as RequestHandler,
    withRoute(async ({ res, orgId }) => {
      const accountOrgId = await accountOrgOr503(res, orgId);
      if (!accountOrgId) return;
      const balance = await supportIncidentsRemaining(accountOrgId);
      return sendSuccess(res, 200, { balance, accountOrgId });
    }),
  );

  /**
   * POST /billing/internal/support-incidents/:orgId/consume  `{ idempotencyKey }`
   *
   * Spend exactly one incident, atomically. `{ consumed, remaining }`. A
   * repeated `idempotencyKey` answers with that key's ORIGINAL outcome and
   * spends nothing, so the caller can re-send a consume whose reply it lost.
   *
   * NAMED-CALLER gated to `message`, matching the shape platform uses for its
   * own internal reads: this is a write that costs the customer something, so
   * it should not be reachable by every service token in the fleet.
   *
   * `consumed: false` is a normal answer, not an error — the org had none, and
   * the caller then opens no case. A 4xx here would make "no incidents left"
   * indistinguishable from "billing is broken", and the case-open path treats
   * those two very differently.
   */
  router.post(
    '/internal/support-incidents/:orgId/consume',
    requireAuth,
    requireInternalService({ callers: [...CONSUME_CALLERS] }),
    withRoute(async ({ req, res }) => {
      const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
      if (!orgId) return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const key = incidentKeyOr400(req, res);
      if (!key) return;
      const accountOrgId = await accountOrgOr503(res, orgId);
      if (!accountOrgId) return;
      const consumed = await consumeSupportIncident(accountOrgId, key, 'service:message');
      const remaining = await supportIncidentsRemaining(accountOrgId);
      if (consumed) logger.info('Support incident consumed', { orgId, accountOrgId, remaining });
      return sendSuccess(res, 200, { consumed, remaining });
    }),
  );

  /**
   * POST /billing/internal/support-incidents/:orgId/refund  `{ idempotencyKey }`
   *
   * Give back the incident spent under `idempotencyKey`. Called when a case
   * insert failed AFTER the incident was spent — without it a customer loses a
   * concession to our own bug, which is the worst possible way to spend one —
   * and when the caller could not learn whether its consume landed. Refunds
   * only a spend that happened, once: `{ refunded, balance }`, where
   * `refunded: false` is the no-op for a key never spent (or already refunded).
   */
  router.post(
    '/internal/support-incidents/:orgId/refund',
    requireAuth,
    requireInternalService({ callers: [...CONSUME_CALLERS] }),
    withRoute(async ({ req, res }) => {
      const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
      if (!orgId) return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const key = incidentKeyOr400(req, res);
      if (!key) return;
      const accountOrgId = await accountOrgOr503(res, orgId);
      if (!accountOrgId) return;
      const { refunded, balance } = await refundSupportIncident(accountOrgId, key, 'service:message');
      if (refunded) logger.warn('Support incident refunded after a failed case open', { orgId, accountOrgId, balance });
      return sendSuccess(res, 200, { refunded, balance });
    }),
  );

  /**
   * POST /billing/admin/orgs/:orgId/support-incidents  `{ count, note? }`
   *
   * GRANT incidents. System-org only and step-up gated: this hands a customer
   * something of value, and it is the half whose absence made the whole
   * mechanism pointless — a concession nobody can grant is not a concession.
   */
  router.post(
    '/admin/orgs/:orgId/support-incidents',
    requireAuth,
    ...requireSystemOrgPermission('support_cases:write'),
    requireStepUp as RequestHandler,
    audited('billing.support-incident.grant'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
      if (!orgId) return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const body = (req.body ?? {}) as { count?: unknown; note?: unknown };
      if (typeof body.count !== 'number' || !Number.isInteger(body.count)
        || body.count < 1 || body.count > MAX_INCIDENT_GRANT) {
        return sendBadRequest(res, `count must be an integer in 1..${MAX_INCIDENT_GRANT}`, ErrorCode.VALIDATION_ERROR);
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        return sendBadRequest(res, 'note must be a string', ErrorCode.VALIDATION_ERROR);
      }

      // A grant typed against a team lands on its account root, where a case
      // opened from that team will look for it.
      const accountOrgId = await accountOrgOr503(res, orgId);
      if (!accountOrgId) return;
      const balance = await grantSupportIncidents(accountOrgId, body.count, actorId({ userId }));
      // Null means no manageable subscription — a cancelled or missing account.
      // 404 rather than a silent success, because a concession the operator
      // believes they granted and the customer never received is worse than a
      // refusal they can see.
      if (balance === null) {
        return sendError(res, 404, 'No manageable subscription for that organization', ErrorCode.NOT_FOUND);
      }

      recordAudit({
        action: 'billing.support-incident.grant',
        actorId: actorId({ userId }),
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: accountOrgId,
        targetType: 'organization',
        targetId: accountOrgId,
        // The count and the resulting balance. A concession is a commercial
        // gift, so "who gave how many, and what did that make the total" is the
        // whole of what a later review needs.
        details: {
          count: body.count,
          balance,
          ...(accountOrgId !== orgId ? { requestedOrgId: orgId } : {}),
          ...(typeof body.note === 'string' && body.note.trim()
            ? { note: body.note.trim().slice(0, 500) }
            : {}),
        },
      });
      ctx.log('COMPLETED', 'Support incidents granted', { orgId, accountOrgId, count: body.count, balance });
      return sendSuccess(res, 201, { balance, accountOrgId });
    }),
  );

  return router;
}
