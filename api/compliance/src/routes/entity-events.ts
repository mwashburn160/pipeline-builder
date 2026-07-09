// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, createLogger, requireAuth, isServicePrincipal, validateBody } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-core';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { evaluateEntityEvent } from '../helpers/entity-event-handler.js';

const logger = createLogger('compliance-entity-events');

const EntityEventSchema = z.object({
  entityId: z.string().min(1),
  orgId: z.string().min(1),
  parentOrgId: z.string().optional(),
  target: z.string().min(1),
  eventType: z.string().min(1),
  userId: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Reject any caller that isn't a service principal. `requireAuth` upstream
 * verifies the JWT signature/expiry; this gate then ensures the token came
 * from `signServiceToken` (peer services use `getServiceAuthHeader`) and
 * not a user JWT. A spoofable HTTP header is not sufficient.
 */
function requireServicePrincipal(req: Request, res: Response, next: NextFunction): void {
  if (!isServicePrincipal(req)) {
    sendBadRequest(res, 'Internal service calls only', ErrorCode.INSUFFICIENT_PERMISSIONS);
    return;
  }
  next();
}

/**
 * Internal endpoint for receiving entity lifecycle events from other services.
 * Evaluates compliance rules against mutated entities and logs audit results.
 *
 * This route is called by the compliance event subscriber registered in
 * plugin/pipeline services via `registerComplianceEventSubscriber()`.
 * It is NOT user-facing — `requireAuth` + `requireServicePrincipal` ensures
 * the caller minted a valid service JWT via `getServiceAuthHeader`.
 */
export function createEntityEventRoutes(): Router {
  const router = Router();

  router.post('/', requireAuth, requireServicePrincipal, async (req: Request, res: Response) => {
    const validation = validateBody(req, EntityEventSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const event = validation.value;

    // Internal service-to-service call: establish the tenant scope from the
    // payload's orgId so any `withTenantTx` inside the rule service or audit
    // logger runs with the right RLS GUCs.
    const result = await runWithTenantContext({ orgId: event.orgId, isSuperAdmin: false }, () =>
      evaluateEntityEvent(event),
    );

    // An evaluation ERROR must NOT read as success — reply non-2xx so the caller
    // (BullMQ) retries instead of letting a non-compliant entity slip through.
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
