// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * billing's org-purge cascade leg (service-to-service only).
 *
 * Platform's durable cascade outbox calls this once per purged org: every
 * billable subscription is cancelled at the payment provider, then the org's
 * subscriptions and billing events are dropped (`purgeOrgBilling`, shared with
 * the admin page's "Purge").
 *
 * The answer is the outbox's ack, read with the leg's `incomplete` hook: a
 * subscription whose provider cancel failed is KEPT and counted in
 * `remaining.subscriptions`, and a 200 carrying a non-zero count is retried —
 * the provider is still charging, so the leg must not be marked done. A store
 * failure is a 500 (also retried). Idempotent: a redelivery matches nothing and
 * answers 200 with zero counts.
 *
 * Registers: POST /billing/internal/orgs/:orgId/purge → { orgId, tables, remaining }
 */

import {
  audited,
  BILLING_INTERNAL,
  contractErrorMessage,
  contractRoute,
  createLogger,
  ErrorCode,
  errorMessage,
  parseContractParams,
  recordAudit,
  requireAuth,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { purgeOrgBilling } from '../helpers/org-purge.js';

const logger = createLogger('billing-internal-org-purge');

const PURGE = BILLING_INTERNAL.purgeOrg;

/** Where `app-routes.ts` mounts this router — the contract's path is under it. */
export const BILLING_MOUNT = '/billing';

/** Audit, never throw: a throwing recorder must not turn an ack into a 500. */
function safeAudit(event: Parameters<typeof recordAudit>[0]): void {
  try {
    recordAudit(event);
  } catch (err) {
    logger.warn('Org purge audit failed', { error: errorMessage(err) });
  }
}

export function createInternalOrgPurgeRoutes(): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, BILLING_MOUNT),
    requireAuth,
    requireInternalService({ callers: PURGE.callers }),
    audited('org.data.purge'),
    async (req: Request, res: Response) => {
      const params = parseContractParams(PURGE, req);
      if (!params.ok) return sendBadRequest(res, contractErrorMessage(params), ErrorCode.MISSING_REQUIRED_FIELD);
      const orgId = String((params.value as { orgId: string }).orgId);
      const audit = {
        action: 'org.data.purge',
        actorId: SYSTEM_ACTOR_ID,
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: orgId,
        targetType: 'organization',
        targetId: orgId,
      } as const;

      try {
        const result = await purgeOrgBilling(orgId, undefined);
        const tables = { subscriptions: result.subscriptions, billingEvents: result.billingEvents };
        const remaining = result.retained > 0 ? { subscriptions: result.retained } : {};
        if (result.retained > 0) {
          // Not an ack (the caller's `incomplete` hook reads `remaining`): the
          // kept subscriptions are still live at the provider.
          safeAudit({ ...audit, outcome: 'failure', details: { owner: 'billing', tables, remaining } });
        } else {
          safeAudit({ ...audit, details: { owner: 'billing', tables } });
        }
        return sendSuccess(res, 200, { orgId, tables, remaining });
      } catch (err) {
        logger.warn('Org billing purge failed', { orgId, error: errorMessage(err) });
        safeAudit({ ...audit, outcome: 'failure', details: { owner: 'billing', error: errorMessage(err) } });
        return sendError(res, 500, 'Org billing purge failed', ErrorCode.INTERNAL_ERROR);
      }
    },
  );
  return router;
}
