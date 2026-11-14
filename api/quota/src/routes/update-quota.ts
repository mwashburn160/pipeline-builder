// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAssurance, requireAuth, requireInternalService, requireStepUp, requireSystemOrg, audited, NotFoundError, sendSuccess, sendBadRequest, sendError, sendQuotaExceeded, ErrorCode, getParam, validateBody, actorId, recordAudit, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';
import { incCounter, withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { resolveRootOrgId } from '../helpers/org-hierarchy.js';
import { authorizeOrg, requireInternalCaller } from '../middleware/authorize-org.js';
import { checkAiControls } from '../services/ai-controls.js';
import { QuotaService, quotaService as defaultQuotaService, OrgNotFoundError } from '../services/quota-service.js';
import { notifyThresholds } from '../services/threshold-notifier.js';
import { recordUsage, recordUsageEvent, type UsageEventInput } from '../services/usage-ledger.js';
import { UpdateQuotaSchema, IncrementQuotaSchema, DecrementQuotaSchema, ReportUsageSchema, ResetQuotaSchema } from '../validation/schemas.js';

export function createUpdateQuotaRoutes(svc: QuotaService = defaultQuotaService): Router {
  const router: Router = Router();

  // The PUT update, shared by the staff route and billing's entitlement-sync
  // route. They differ only in who may call them and how the audit row is
  // attributed.
  const updateQuota = (actor: 'staff' | 'billing') =>
    withRoute(async ({ req, res, ctx, userId }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const validation = validateBody(req, UpdateQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const body = validation.value;

      try {
        const result = await svc.update(targetOrgId, body);
        ctx.log('COMPLETED', 'Updated quota', { orgId: targetOrgId });

        // Best-effort attributed audit — the tier/limit edit succeeded. The new
        // limits are read back off the applied result; numeric limits + tier are
        // safe to record (no secrets / AWS account ids).
        const changedQuotaTypes = body.quotas ? Object.keys(body.quotas) : [];
        const newLimits = Object.fromEntries(
          changedQuotaTypes.map((t) => [t, result.quotas[t as QuotaType]?.limit]),
        );
        recordAudit({
          action: 'quota.limit.update',
          actorId: actorId({ userId }),
          // Staff act from the system org on a tenant (`requireSystemOrg`);
          // billing's sync is recorded FOR the org it targets, like the
          // reporting and compliance legs.
          orgId: actor === 'staff' ? SYSTEM_ORG_ID : targetOrgId,
          affectedOrgId: targetOrgId,
          details: {
            ...(body.tier !== undefined ? { tier: body.tier } : {}),
            ...(changedQuotaTypes.length ? { quotaTypes: changedQuotaTypes, newLimits } : {}),
          },
        });

        return sendSuccess(res, 200, { quota: result }, 'Updated successfully');
      } catch (error) {
        if (error instanceof OrgNotFoundError) throw new NotFoundError('Organization not found.');
        throw error;
      }
    });

  // PUT /quotas/:orgId — update org name, slug, and/or quota limits.
  // `quotas:manage` (system-org-only) + aal2, not the superadmin flag: Platform
  // Operator and Account Manager both carry it.

  router.put( '/:orgId',
    requireAuth as RequestHandler,
    // `requireSystemOrg` + aal2 beside the permission, the same AND the console
    // and ecosystem routes take: `quotas:manage` is system-org-only, so the
    // caller's ACTIVE org must be the system org too. `requireSystemOrgPermission`
    // would compose all three, but `authorizeOrg` has to stay — it canonicalizes
    // the `:orgId` param, and without that a mixed-case id resolves to "no such
    // org" downstream.
    requireSystemOrg as RequestHandler,
    authorizeOrg({ permission: 'quotas:manage' }) as RequestHandler,
    requireAssurance({ minAssurance: 2 }) as RequestHandler,
    audited('quota.limit.update'),
    updateQuota('staff'),
  );

  // PUT /quotas/entitlement-sync/:orgId — billing → quota entitlement sync.
  //
  // INTERNAL: only billing's own signed token passes, and no user token does,
  // however privileged. Same shape as the reporting and compliance legs
  // (`PUT /reports/retention-sync/:orgId`, `PUT /compliance/entitlements/:orgId`)
  // and billing's `GET /:orgId/own-usage` read here. Billing cannot use the
  // staff route above: it has no system-org session or MFA, and its token is
  // minted for the TARGET org, so `requireSystemOrg` refuses it.

  router.put( '/entitlement-sync/:orgId',
    requireAuth as RequestHandler,
    // Same-org (billing mints its token for the target org); canonicalizes `:orgId`.
    authorizeOrg() as RequestHandler,
    requireInternalService({ callers: ['billing'] }) as RequestHandler,
    audited('quota.limit.update'),
    updateQuota('billing'),
  );

  // DELETE /quotas/:orgId — cascade hook, `quotas:manage` + aal2. Drops the
  // org's quota document. Idempotent: returns 200 with `deleted: false` when
  // the org was already gone, which lets the platform cascade run repeatedly
  // without orchestration babysitting.

  router.delete( '/:orgId',
    requireAuth as RequestHandler,
    // `requireSystemOrg` + aal2 beside the permission, the same AND the console
    // and ecosystem routes take: `quotas:manage` is system-org-only, so the
    // caller's ACTIVE org must be the system org too. `requireSystemOrgPermission`
    // would compose all three, but `authorizeOrg` has to stay — it canonicalizes
    // the `:orgId` param, and without that a mixed-case id resolves to "no such
    // org" downstream.
    requireSystemOrg as RequestHandler,
    authorizeOrg({ permission: 'quotas:manage' }) as RequestHandler,
    requireAssurance({ minAssurance: 2 }) as RequestHandler,
    // Destructive: drops the org's quota doc (removes enforcement). Step-up
    // re-verifies the human sysadmin; the platform cascade's service token is
    // exempt (requireStepUp skips verified service principals) so org-delete
    // still works unattended.
    requireStepUp as RequestHandler,
    audited('quota.delete'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;
      const deleted = await svc.delete(targetOrgId);
      ctx.log('COMPLETED', deleted ? 'Quota org deleted': 'Quota org delete: not found', { orgId: targetOrgId });

      // Best-effort attributed audit — emitted only when a quota document was
      // actually dropped (the idempotent no-op path mutates nothing). This is a
      // cross-tenant sysadmin op, so `affectedOrgId` records the target org.
      if (deleted) {
        recordAudit({
          action: 'quota.delete',
          actorId: actorId({ userId }),
          // The actor is system-org staff (`requireSystemOrg`) acting on a tenant.
          orgId: SYSTEM_ORG_ID,
          affectedOrgId: targetOrgId,
          details: { deleted: true },
        });
      }

      return sendSuccess(res, 200, { deleted }, deleted ? 'Quota org deleted': 'Quota org was already absent');
    }),
  );

  // POST /quotas/:orgId/reset — reset usage counters. `quotas:manage` + aal2.

  router.post( '/:orgId/reset',
    requireAuth as RequestHandler,
    // `requireSystemOrg` + aal2 beside the permission, the same AND the console
    // and ecosystem routes take: `quotas:manage` is system-org-only, so the
    // caller's ACTIVE org must be the system org too. `requireSystemOrgPermission`
    // would compose all three, but `authorizeOrg` has to stay — it canonicalizes
    // the `:orgId` param, and without that a mixed-case id resolves to "no such
    // org" downstream.
    requireSystemOrg as RequestHandler,
    authorizeOrg({ permission: 'quotas:manage' }) as RequestHandler,
    requireAssurance({ minAssurance: 2 }) as RequestHandler,
    // Destructive: zeroes an org's usage counters (lets it re-consume against
    // its caps). Step-up re-verifies the human sysadmin; service principals exempt.
    requireStepUp as RequestHandler,
    audited('quota.reset'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const validation = validateBody(req, ResetQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { quotaType } = validation.value;

      try {
        const result = await svc.resetUsage(targetOrgId, quotaType);
        ctx.log('COMPLETED', 'Reset quota usage', { orgId: targetOrgId, quotaType });

        // Best-effort attributed audit — the usage-counter reset succeeded.
        // Reset zeroes the affected counter(s); `newUsed: 0` records the applied
        // value (the pre-reset counter is not read back here).
        recordAudit({
          action: 'quota.reset',
          actorId: actorId({ userId }),
          // The actor is system-org staff (`requireSystemOrg`) acting on a tenant.
          orgId: SYSTEM_ORG_ID,
          affectedOrgId: targetOrgId,
          details: { quotaType: quotaType ?? 'all', newUsed: 0 },
        });

        return sendSuccess( res, 200,
          { quota: result },
          quotaType ? `${quotaType} usage reset successfully`: 'All quota usage reset successfully',
        );
      } catch (error) {
        if (error instanceof OrgNotFoundError) throw new NotFoundError('Organization not found.');
        throw error;
      }
    }),
  );

  // POST /quotas/:orgId/increment  increment usage (INTERNAL route, #14)
  //
  // Every service meters its own inbound traffic through api-core's quota
  // client, so the caller list is the whole internal fleet — but it is still a
  // closed list of cryptographically-named services, and NO user token reaches
  // it, not even a superadmin's: a member who could increment or decrement their
  // own counters would defeat the caps outright.

  router.post( '/:orgId/increment',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    // authorizeOrg() alone admits any same-org member — this is what makes the
    // endpoint service-only.
    requireInternalCaller as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      // AFTER-THE-CALL usage REPORT (api-core `QuotaService.reportUsage`): an AI
      // call's token counts under its attribution. No counter moves — a
      // zero-unit ledger row only, so it is never refused and needs no limit read.
      if ((req.body as { report?: unknown } | undefined)?.report === true) {
        const report = validateBody(req, ReportUsageSchema);
        if (!report.ok) return sendBadRequest(res, report.error, ErrorCode.VALIDATION_ERROR);
        const { tokensIn, tokensOut, attribution } = report.value;
        const rootOrgId = await resolveRootOrgId(targetOrgId);
        recordUsageEvent({ orgId: targetOrgId, rootOrgId, quotaType: 'aiCalls', amount: 0, outcome: 'counted', attribution, tokensIn, tokensOut, report: true });
        ctx.log('COMPLETED', 'Recorded AI usage report', { orgId: targetOrgId, tokensIn, tokensOut, feature: attribution?.feature });
        return sendSuccess(res, 200, { recorded: true }, 'Usage reported');
      }

      const validation = validateBody(req, IncrementQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { quotaType, amount, attribution, meter, groups } = validation.value;

      try {
        const typedType = quotaType as QuotaType;

        // METERED batch (api-core's per-pod increment batcher): partial
        // admission, never a 429 — the requests were already served. The
        // counted part lands as `counted`, the rest as `overshoot`.
        if (meter) {
          const result = await svc.incrementMetered(targetOrgId, typedType, amount);
          recordUsage(splitMeteredGroups(targetOrgId, result.rootOrgId, typedType, groups ?? [{ amount, attribution }], result.counted));
          // UNITS PAST THE CAP, as a series rather than only as rows.
          //
          // The per-org rows already land in `usage_events` with full
          // attribution, which is the drill-down; this is what an ALERT can see.
          // It exists because overshoot is how the build meter's one known
          // imprecision shows up: admission is a check rather than a
          // reservation, so two builds submitted at the cap can both be admitted
          // and each overshoot by its own cost. That exposure is bounded (the
          // per-org slot caps x the per-build wall-clock bound), small, and in
          // the customer's favour — so it is MEASURED rather than prevented, and
          // this is the measurement. If it ever stops being small, the series is
          // what says so.
          if (result.overshoot > 0) {
            incCounter('quota_overshoot_total', { type: quotaType }, result.overshoot);
          }
          // Nothing counted ⇒ nothing crossed; the notifier skips it cheaply.
          void notifyThresholds({
            rootOrgId: result.rootOrgId,
            quotaType: typedType,
            limit: result.quota.limit,
            used: result.quota.used,
            amount: result.counted,
            resetAt: result.quota.resetAt,
          });
          ctx.log('COMPLETED', 'Applied metered quota increment', { orgId: targetOrgId, quotaType, amount, counted: result.counted, overshoot: result.overshoot });
          return sendSuccess(res, 200, { quota: result.quota, counted: result.counted, overshoot: result.overshoot }, 'Usage metered');
        }

        // The account's OPTIONAL AI controls (per-member share, token budget),
        // checked before the counter moves. Off unless a billing contact set
        // them; a refusal is a distinct 429 code the calling service relays.
        if (typedType === 'aiCalls') {
          const denial = await checkAiControls(svc, targetOrgId, amount, attribution);
          if (denial) {
            recordUsageEvent({ orgId: targetOrgId, rootOrgId: await resolveRootOrgId(targetOrgId), quotaType: typedType, amount, outcome: 'denied', attribution });
            ctx.log('INFO', 'aiCalls reservation refused by an AI control', { orgId: targetOrgId, code: denial.code });
            if (!res.headersSent) res.setHeader('Retry-After', Math.max(0, Math.ceil((new Date(denial.quota.resetAt).getTime() - Date.now()) / 1000)));
            return sendError(res, 429, denial.message, denial.code, { quota: denial.quota, quotaType, resetAt: denial.quota.resetAt });
          }
        }

        // No bypass: the only callers are services, and a service metering a
        // tenant's usage must never be able to waive that tenant's cap — the
        // service has no bypass path at all.
        const result = await svc.incrementUsage(targetOrgId, typedType, amount);

        // Ledger + notices are fire-and-forget: attribution, never enforcement.
        // A DENIAL (a reservation refused at the limit) is recorded too — the
        // counter stops at the limit, so the ledger is the only place a refused
        // attempt is visible.
        recordUsageEvent({
          orgId: targetOrgId,
          rootOrgId: result.rootOrgId,
          quotaType: typedType,
          amount,
          outcome: result.exceeded ? 'denied' : 'counted',
          attribution,
        });
        void notifyThresholds({
          rootOrgId: result.rootOrgId,
          quotaType: typedType,
          limit: result.quota.limit,
          used: result.quota.used,
          amount: result.exceeded ? 0 : amount,
          resetAt: result.quota.resetAt,
        });

        if (result.exceeded) {
          return sendQuotaExceeded( res,
            quotaType,
            {
              type: result.quota.type,
              limit: result.quota.limit,
              used: result.quota.used,
              remaining: result.quota.remaining,
            },
            result.quota.resetAt,
            undefined,
            // The calling service re-answers this refusal to its user (and
            // counts it there); counting here too would double every denial.
            { countDenial: false },
          );
        }

        ctx.log('COMPLETED', 'Incremented quota usage', { orgId: targetOrgId, quotaType, amount });
        return sendSuccess(res, 200, { quota: result.quota }, 'Usage incremented successfully');
      } catch (error) {
        if (error instanceof OrgNotFoundError) throw new NotFoundError('Organization not found.');
        throw error;
      }
    }),
  );

  // POST /quotas/:orgId/decrement  roll back a previously reserved increment.
  // Internal-only, same auth as /increment. Used by routes that adopt the
  // "reserve before action, rollback on failure" pattern to give the
  // quota slot back when the action they were gating fails.
  //
  // Body MAY include `resetAtSnapshot` (the `resetAt` ISO string observed at
  // reserve time). When supplied, the service no-ops the decrement if the
  // period rolled over between reserve and rollback, so we don't steal
  // capacity from the new period.

  router.post( '/:orgId/decrement',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    // Internal service-to-service only — same gate and reasoning as /increment.
    requireInternalCaller as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const validation = validateBody(req, DecrementQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { quotaType, amount, resetAtSnapshot, attribution } = validation.value;

      const typedType = quotaType as QuotaType;
      const result = await svc.decrementUsage(targetOrgId, typedType, amount, { resetAtSnapshot });
      if (result?.applied) {
        recordUsageEvent({ orgId: targetOrgId, rootOrgId: result.rootOrgId, quotaType: typedType, amount, outcome: 'refunded', attribution });
      }

      // Org not found is reported via 200 + `quota: null` rather than 404 so
      // that fire-and-forget rollback paths don't add a spurious error when
      // the original action's failure was already org-not-found.
      if (!result) {
        ctx.log('WARN', 'Decrement skipped: org not found', { orgId: targetOrgId, quotaType });
        return sendSuccess(res, 200, { quota: null }, 'Org not found, decrement skipped');
      }

      ctx.log('COMPLETED', 'Decremented quota usage', { orgId: targetOrgId, quotaType, amount });
      return sendSuccess(res, 200, { quota: result.quota }, 'Usage decremented successfully');
    }),
  );

  return router;
}

/**
 * Ledger rows for a metered batch: `counted` units are allocated to the groups
 * in order, the remainder of each group is `overshoot`. Which group "got" the
 * last units under the cap is arbitrary within one flush (the requests were
 * concurrent); the totals per outcome are exact.
 */
export function splitMeteredGroups(
  orgId: string,
  rootOrgId: string,
  quotaType: QuotaType,
  groups: { amount: number; attribution?: UsageEventInput['attribution'] }[],
  counted: number,
): UsageEventInput[] {
  const rows: UsageEventInput[] = [];
  let left = counted;
  for (const g of groups) {
    const inCap = Math.min(left, g.amount);
    left -= inCap;
    if (inCap > 0) rows.push({ orgId, rootOrgId, quotaType, amount: inCap, outcome: 'counted', attribution: g.attribution });
    if (g.amount > inCap) rows.push({ orgId, rootOrgId, quotaType, amount: g.amount - inCap, outcome: 'overshoot', attribution: g.attribution });
  }
  return rows;
}
