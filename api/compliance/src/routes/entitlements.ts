// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  getParam,
  isSystemAdmin,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { entitlementWatermarkStore } from '../services/entitlement-watermark-store.js';
import { emitComplianceAudit } from '../services/remote-audit-client.js';
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
 * Machine-only auth for the entitlement-sync legs. Tightened beyond "any service
 * principal" to the SPECIFIC billing service identity (`sub: service:billing`)
 * that owns entitlement — plus a system-admin for manual reconcile/ops. Billing
 * is the sole legitimate driver of this push, so no other service token (a
 * compromised or mis-scoped one) can rewrite an org's enforced compliance sets.
 */
function isBillingOrSysadmin(req: Request): boolean {
  return isSystemAdmin(req) || req.user?.sub === 'service:billing';
}

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
 * AUTH: identical to the reporting `PUT /reports/retention-sync/:orgId` leg and
 * platform's `PUT /organization/:id/seat-limit` — a SERVICE PRINCIPAL or a
 * system-admin. The billing service token (`sub: service:billing`) satisfies
 * `isServicePrincipal`; it carries NO org-user permission and NO feature scope,
 * so the guard must require neither. The `:orgId` path param is the target ROOT
 * org (billing resolves to root before calling), NOT the token's org — so the
 * route runs with `requireOrgId: false` and reads the id from the path.
 */
export function createEntitlementSyncRoutes(): Router {
  const router = Router();

  router.put('/:orgId', withRoute(async ({ req, res, ctx }) => {
    // Service-to-service entitlement sync: accept ONLY the billing service token
    // (or a sysadmin), never a plain org-user JWT nor any other service token.
    if (!isBillingOrSysadmin(req)) {
      return sendError(res, 403, 'Forbidden: billing service or system-admin only', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const orgId = getParam(req.params, 'orgId');
    if (!orgId) return sendBadRequest(res, 'orgId path parameter is required', ErrorCode.VALIDATION_ERROR);

    const validation = validateBody(req, EntitlementsSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    // Sync-race guard: pushes can arrive out of order (concurrent purchase + the
    // periodic drift reconciler, retries, at-least-once delivery). Apply only a
    // push STRICTLY NEWER than the last-applied change; a stale one is ignored so
    // it can't revert a newer entitlement state. The watermark is advanced only
    // AFTER a successful reconcile (below), so a mid-sync failure re-drives.
    const occurredAt = validation.value.occurredAt ? new Date(validation.value.occurredAt) : undefined;
    if (occurredAt) {
      const last = await entitlementWatermarkStore.getLastOccurredAt(orgId);
      if (last && occurredAt.getTime() <= last.getTime()) {
        ctx.log('COMPLETED', 'Skipped stale entitlement sync', { orgId, occurredAt: occurredAt.toISOString(), last: last.toISOString() });
        return sendSuccess(res, 200, { ok: true, skipped: true });
      }
    }

    // Clamp to the sets the compliance side actually curates — an unknown/removed
    // set name is ignored rather than 400'ing the whole sync.
    const known = new Set<string>(KNOWN_CONTENT_SETS);
    const sets = validation.value.sets.filter((s) => known.has(s));

    const actor = req.user?.sub ?? 'service:billing';
    const { activated, deactivated } = await subscriptionService.syncEntitledSets(orgId, sets, actor);

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

    // Advance the watermark only after a successful reconcile so a mid-sync
    // failure leaves the last-applied marker untouched (billing re-drives).
    if (occurredAt) await entitlementWatermarkStore.record(orgId, occurredAt);

    ctx.log('COMPLETED', 'Synced compliance entitlement sets', {
      orgId, sets, activated: activated.length, deactivated: deactivated.length,
    });
    return sendSuccess(res, 200, { ok: true, activated: activated.length, deactivated: deactivated.length });
  }, { requireOrgId: false }));

  // GET /:orgId — drift-read: the org's currently-ENFORCED compliance content
  // sets (distinct `set:<x>` among its ACTIVE published-rule subscriptions).
  // Billing's drift reconciler GETs this and diffs against the sets it expects
  // the org to hold, re-driving the PUT push on mismatch. Same machine-only
  // guard as the PUT — the `:orgId` is the target root org, not the token's org.
  router.get('/:orgId', withRoute(async ({ req, res, ctx }) => {
    if (!isBillingOrSysadmin(req)) {
      return sendError(res, 403, 'Forbidden: billing service or system-admin only', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const orgId = getParam(req.params, 'orgId');
    if (!orgId) return sendBadRequest(res, 'orgId path parameter is required', ErrorCode.VALIDATION_ERROR);

    const sets = await subscriptionService.getActiveEntitledSets(orgId);
    ctx.log('COMPLETED', 'Read active compliance entitlement sets', { orgId, sets });
    return sendSuccess(res, 200, { sets });
  }, { requireOrgId: false }));

  return router;
}
