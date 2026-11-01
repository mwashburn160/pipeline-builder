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
  getParam,
  recordAudit,
  requireAuth,
  requireInternalService,
  requireStepUp,
  requireSystemAdmin,
  sendBadRequest,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import {
  MAX_INCIDENT_GRANT,
  consumeSupportIncident,
  grantSupportIncidents,
  refundSupportIncident,
  supportIncidentsRemaining,
} from '../helpers/support-incidents.js';

const logger = createLogger('support-incidents-routes');

/** The one service allowed to spend an incident. */
const CONSUME_CALLERS = ['message'] as const;

export function createSupportIncidentRoutes(): Router {
  const router: Router = Router();

  /**
   * POST /billing/internal/support-incidents/:orgId/consume
   *
   * Spend exactly one incident, atomically. `{ consumed, remaining }`.
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
      const consumed = await consumeSupportIncident(orgId, 'service:message');
      const remaining = await supportIncidentsRemaining(orgId);
      if (consumed) logger.info('Support incident consumed', { orgId, remaining });
      return sendSuccess(res, 200, { consumed, remaining });
    }),
  );

  /**
   * POST /billing/internal/support-incidents/:orgId/refund
   *
   * Give one back. Called when a case insert failed AFTER the incident was
   * spent — without it a customer loses a concession to our own bug, which is
   * the worst possible way to spend one.
   */
  router.post(
    '/internal/support-incidents/:orgId/refund',
    requireAuth,
    requireInternalService({ callers: [...CONSUME_CALLERS] }),
    withRoute(async ({ req, res }) => {
      const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
      if (!orgId) return sendBadRequest(res, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const balance = await refundSupportIncident(orgId, 'service:message');
      logger.warn('Support incident refunded after a failed case open', { orgId, balance });
      return sendSuccess(res, 200, { balance });
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
    requireSystemAdmin as RequestHandler,
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

      const balance = await grantSupportIncidents(orgId, body.count, actorId({ userId }));
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
        affectedOrgId: orgId,
        targetType: 'organization',
        targetId: orgId,
        // The count and the resulting balance. A concession is a commercial
        // gift, so "who gave how many, and what did that make the total" is the
        // whole of what a later review needs.
        details: {
          count: body.count,
          balance,
          ...(typeof body.note === 'string' && body.note.trim()
            ? { note: body.note.trim().slice(0, 500) }
            : {}),
        },
      });
      ctx.log('COMPLETED', 'Support incidents granted', { orgId, count: body.count, balance });
      return sendSuccess(res, 201, { balance });
    }),
  );

  return router;
}
