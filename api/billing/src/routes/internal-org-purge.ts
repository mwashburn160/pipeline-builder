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
  contractRoute,
  requireAuth,
  requireInternalService,
} from '@pipeline-builder/api-core';
import { handleOrgDataPurge, type OrgPurgeOutcome } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { purgeOrgBilling } from '../helpers/org-purge.js';

const PURGE = BILLING_INTERNAL.purgeOrg;

/** Where `app-routes.ts` mounts this router — the contract's path is under it. */
export const BILLING_MOUNT = '/billing';

/**
 * `purgeOrgBilling` in the shared envelope's terms: kept subscriptions become
 * `remaining` (always present in the reply — empty on a complete purge).
 */
async function purgeBilling(orgId: string): Promise<OrgPurgeOutcome> {
  const result = await purgeOrgBilling(orgId, undefined);
  return {
    tables: { subscriptions: result.subscriptions, billingEvents: result.billingEvents },
    remaining: result.retained > 0 ? { subscriptions: result.retained } : {},
  };
}

export function createInternalOrgPurgeRoutes(): Router {
  const router: Router = Router();
  router.post(
    contractRoute(PURGE, BILLING_MOUNT),
    requireAuth,
    requireInternalService({ callers: PURGE.callers }),
    audited('org.data.purge'),
    async (req, res) => handleOrgDataPurge(req, res, {
      contract: PURGE, service: 'billing', purge: purgeBilling, auditAction: 'org.data.purge',
    }),
  );
  return router;
}
