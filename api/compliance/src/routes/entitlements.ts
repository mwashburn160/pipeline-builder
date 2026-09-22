// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  ErrorCode,
  audited,
  getParam,
  requireInternalService,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { emitComplianceAudit } from '../services/audit.js';
import { subscriptionService, KNOWN_CONTENT_SETS } from '../services/subscription-service.js';

/**
 * Body of the entitlement-sync push: the compliance content sets the org is
 * currently ENTITLED to, plus the OPTIONAL `occurredAt` timestamp of the
 * entitlement change (billing stamps it). Unknown set names are accepted by the
 * schema but filtered out below, so a future billing-side set can't error this
 * leg before the compliance side learns about it (forward-compatible, no
 * coupling).
 */
const EntitlementsSchema = z.object({
  sets: z.array(z.string()).max(16),
  occurredAt: z.string().datetime().optional(),
});

/**
 * Machine-only auth for the entitlement-sync legs: the SPECIFIC billing service
 * identity that owns entitlement, and nothing else.
 *
 * Since #14 the name is cryptographically bound to the signing key, so this is
 * an identity check rather than a claim check: no other service — compromised or
 * mis-scoped — can rewrite an org's enforced compliance sets, and no user token
 * can qualify by shaping its own subject. The system-admin escape hatch that
 * used to sit alongside it is GONE: an internal route refuses every user token,
 * however privileged. Manual reconcile is billing's drift reconciler, which
 * re-drives the push on its own schedule.
 */
const requireBillingService = requireInternalService({ callers: ['billing'] });

/**
 * Inbound billing → compliance entitlement sync.
 *
 * `PUT /:orgId` — billing pushes the account's EFFECTIVE compliance content
 * entitlement (derived from its feature set: `compliance_standard`→`'standard'`,
 * `compliance_advanced`→`'advanced'`) so the compliance side can auto-subscribe
 * + activate the entitled curated libraries and deactivate the rest. Idempotent
 * reconcile — safe on every purchase/cancel/renew AND via billing's drift
 * reconciler.
 *
 * AUTH: an INTERNAL route (#14), identical to the reporting
 * `PUT /reports/retention-sync/:orgId` leg — only `billing`'s own signed token
 * passes. It carries NO org-user permission and NO feature scope, so the guard
 * must require neither. The `:orgId` path param is the target ROOT org (billing
 * resolves to root before calling), NOT the token's org — so the route runs with
 * `requireOrgId: false` and reads the id from the path.
 */
export function createEntitlementSyncRoutes(): Router {
  const router = Router();

  router.put('/:orgId', requireBillingService, audited('compliance.rule.toggle'), withRoute(async ({ req, res, ctx }) => {
    const orgId = getParam(req.params, 'orgId');
    if (!orgId) return sendBadRequest(res, 'orgId path parameter is required', ErrorCode.VALIDATION_ERROR);

    const validation = validateBody(req, EntitlementsSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    // Clamp to the sets the compliance side actually curates — an unknown/removed
    // set name is ignored rather than 400'ing the whole sync.
    const known = new Set<string>(KNOWN_CONTENT_SETS);
    const sets = validation.value.sets.filter((s) => known.has(s));

    // Sync-race guard: pushes can arrive out of order (concurrent purchase + the
    // periodic drift reconciler, retries, at-least-once delivery). The service
    // applies only a push STRICTLY NEWER than the last-applied change, and does
    // the watermark check, the reconcile and the watermark record in ONE
    // transaction under a per-org advisory lock — so two concurrent pushes can't
    // both pass the check and then apply in the wrong order.
    const occurredAt = validation.value.occurredAt ? new Date(validation.value.occurredAt) : undefined;
    const actor = req.user?.sub ?? 'service:billing';
    const { skipped, activated, deactivated } = await subscriptionService.syncEntitledSets(orgId, sets, actor, occurredAt ? { occurredAt } : {});
    if (skipped) {
      ctx.log('COMPLETED', 'Skipped stale entitlement sync', { orgId, occurredAt: occurredAt?.toISOString() });
      return sendSuccess(res, 200, { ok: true, skipped: true });
    }

    // Audit the genuine posture changes only (the ids whose ACTIVE state flipped).
    // Reuse `compliance.rule.toggle` — the same action the user-driven activate/
    // deactivate routes emit — tagged with the entitlement-sync source so a
    // reviewer can tell an automated reconcile from a manual toggle.
    for (const ruleId of activated) {
      emitComplianceAudit({
        action: 'compliance.rule.toggle',
        actorId: actor,
        orgId,
        targetType: 'rule',
        targetId: ruleId,
        details: { isActive: true, source: 'entitlement-sync' },
      });
    }
    for (const ruleId of deactivated) {
      emitComplianceAudit({
        action: 'compliance.rule.toggle',
        actorId: actor,
        orgId,
        targetType: 'rule',
        targetId: ruleId,
        details: { isActive: false, source: 'entitlement-sync' },
      });
    }

    ctx.log('COMPLETED', 'Synced compliance entitlement sets', {
      orgId, sets, activated: activated.length, deactivated: deactivated.length,
    });
    return sendSuccess(res, 200, { ok: true, activated: activated.length, deactivated: deactivated.length });
  }, { requireOrgId: false }));

  // GET /:orgId — drift-read: the org's currently-ENFORCED compliance content
  // sets (distinct `set:<x>` among its ACTIVE published-rule subscriptions).
  // Billing's drift reconciler GETs this and diffs against the sets it expects
  // the org to hold, re-driving the PUT push on mismatch. Same internal-route
  // guard as the PUT — the `:orgId` is the target root org, not the token's org.
  router.get('/:orgId', requireBillingService, withRoute(async ({ req, res, ctx }) => {
    const orgId = getParam(req.params, 'orgId');
    if (!orgId) return sendBadRequest(res, 'orgId path parameter is required', ErrorCode.VALIDATION_ERROR);

    const sets = await subscriptionService.getActiveEntitledSets(orgId);
    ctx.log('COMPLETED', 'Read active compliance entitlement sets', { orgId, sets });
    return sendSuccess(res, 200, { sets });
  }, { requireOrgId: false }));

  return router;
}
