// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, createLogger, requireAuth, requireInternalService, serviceNameOf, SYSTEM_ACTOR_ID, validateBody } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { evaluateEntityEvent } from '../helpers/entity-event-handler.js';

const logger = createLogger('compliance-entity-events');

const EntityEventSchema = z.object({
  entityId: z.string().min(1),
  orgId: z.string().min(1),
  target: z.string().min(1),
  eventType: z.string().min(1),
  /** The user the producer says performed the mutation — logged as "requested
   *  by", never trusted as the audit actor. */
  userId: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Internal endpoint for receiving entity lifecycle events from other services.
 * Evaluates compliance rules against mutated entities and logs audit results.
 *
 * This route is called by the compliance event subscriber registered in
 * plugin/pipeline services via `registerComplianceEventSubscriber()`.
 * It is NOT user-facing — `requireAuth` + `requireInternalService` admits only
 * those two services' own signed tokens, and refuses every user token.
 *
 * The payload's `orgId` must be the org the caller's token was minted for (the
 * subscriber mints one per event, scoped to the event's org). It decides whose
 * rules run, whose exemptions apply, which tenant's RLS scope the evaluation
 * and its audit rows are written under, so a body-supplied org that disagreed
 * with the verified token would let one signed token write compliance verdicts
 * into any tenant.
 *
 * Nothing else that decides the verdict or its attribution comes from the body:
 * the org's parent (whose `propagateToChildren` rules apply) is resolved from
 * the org hierarchy, and the audit actor is the verified caller service.
 */
export function createEntityEventRoutes(): Router {
  const router = Router();

  router.post('/', requireAuth, requireInternalService({ callers: ['pipeline', 'plugin'] }), async (req: Request, res: Response) => {
    const validation = validateBody(req, EntityEventSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const event = validation.value;

    const tokenOrgId = req.user?.organizationId?.trim().toLowerCase();
    if (!tokenOrgId || tokenOrgId !== event.orgId.trim().toLowerCase()) {
      logger.warn('Entity event refused: payload orgId does not match the caller token', { entityId: event.entityId });
      return sendError(res, 403, 'Entity event orgId does not match the caller\'s token organization', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Internal service-to-service call: establish the tenant scope from the
    // (token-verified) orgId so any `withTenantTx` inside the rule service or audit
    // logger runs with the right RLS GUCs.
    const caller = serviceNameOf(req.user);
    const result = await runWithTenantContext({ orgId: event.orgId, isSuperAdmin: false }, () =>
      evaluateEntityEvent({
        entityId: event.entityId,
        orgId: event.orgId,
        target: event.target,
        eventType: event.eventType,
        actorId: caller ? `service:${caller}` : SYSTEM_ACTOR_ID,
        requestedBy: event.userId,
        attributes: event.attributes,
      }),
    );

    // An evaluation ERROR must NOT read as success — reply non-2xx so the
    // caller's HTTP client retries (and, past its retries, counts the drop)
    // instead of letting a non-compliant entity slip through.
    if (result.error) {
      return sendError(res, 500, 'Compliance evaluation failed; retry', ErrorCode.INTERNAL_ERROR);
    }
    if (!result.evaluated) {
      logger.debug('Entity event not evaluated', { entityId: event.entityId, reason: result.reason });
    }
    return sendSuccess(res, 200, result);
  });

  return router;
}
