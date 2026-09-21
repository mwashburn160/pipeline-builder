// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  audited,
  requireAuth,
  requirePermission,
  requireSystemAdmin,
  requireStepUp,
  sendSuccess,
  sendError,
  sendBadRequest,
  ErrorCode,
  createLogger,
  errorMessage,
  getParam,
  parseQueryInt,
  parseQueryIntClamped,
  parseQueryString,
  validateBody,
  actorId,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { applyPlanTierChange, applyTierIncludedAddonPrune } from '../helpers/addon-prune.js';
import { billingServiceAuth, buildSubscriptionResponse, createBillingEvent, MANAGEABLE_SUBSCRIPTION_STATUSES, recordReactivatePlanMissing, syncEntitlements, syncProviderAddons } from '../helpers/billing-helpers.js';
import { BillingEvent } from '../models/billing-event.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { getAuditClient } from '../services/audit.js';
import { AdminSubscriptionUpdateSchema } from '../validation/schemas.js';

const logger = createLogger('billing-admin-subscriptions');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * The un-subscribed BASELINE tier an account falls back to when its
 * subscription enters a terminal / non-entitled status — mirrors the normal
 * cancel/grace-expiry/webhook-delete downgrade paths, which all sync to
 * `developer` with add-ons cleared (see subscription-lifecycle + stripe-webhook).
 */
const BASELINE_TIER = 'developer' as const;

/** Whether a subscription status is entitlement-worthy (paid tier enforced). */
function isEntitledStatus(status: string): boolean {
  return (MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** Project a BillingEvent lean doc → API response. Shared by the admin
 *  `/admin/events` list and the caller-scoped `/events` list so the two can't
 *  drift (mirrors `toDiscountResponse` / `toPromotionResponse`). */
function toBillingEventResponse(event: {
  _id: { toString(): string };
  orgId: string;
  subscriptionId?: string | null;
  type: string;
  actorId?: string | null;
  details: unknown;
  createdAt: Date;
}) {
  return {
    id: event._id.toString(),
    orgId: event.orgId,
    subscriptionId: event.subscriptionId,
    type: event.type,
    // Who initiated it (undefined for system/webhook/cron rows).
    actorId: event.actorId,
    details: event.details,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * Create the admin-only billing router (system admin required).
 *
 * Registers:
 * - GET /admin/subscriptions      -- list all subscriptions (paginated)
 * - PUT /admin/subscriptions/:id  -- admin override on a subscription
 * - GET /subscriptions/by-org/:orgId/billable -- org-move guard (sysadmin / service token)
 * - DELETE /subscriptions/by-org/:orgId -- org-cascade hook (sysadmin / service token)
 * - GET /admin/events             -- list billing events (paginated)
 * @returns Express Router
 */
export function createAdminSubscriptionRoutes(): Router {
  const router: Router = Router();

  // GET /billing/admin/subscriptions — list all subscriptions

  router.get(
    '/admin/subscriptions',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const limit = parseQueryIntClamped(req.query.limit, 50, 200);
      const offset = parseQueryInt(req.query.offset, 0);
      const status = parseQueryString(req.query.status);

      const filter: Record<string, unknown> = {};
      if (status) filter.status = status;

      const [subscriptions, total] = await Promise.all([
        Subscription.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        Subscription.countDocuments(filter),
      ]);

      const result = subscriptions.map((sub) => buildSubscriptionResponse(sub));

      ctx.log('COMPLETED', 'Listed all subscriptions', { total, limit, offset });
      return sendSuccess(res, 200, { subscriptions: result, total, limit, offset });
    }, { requireOrgId: false }),
  );

  // PUT /billing/admin/subscriptions/:id — admin override subscription

  router.put(
    '/admin/subscriptions/:id',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    // Sysadmin override can force-cancel/downgrade any org's subscription — a
    // high-impact cross-tenant mutation. Step-up re-verifies the human; a
    // service principal (none call this today) would be exempt.
    requireStepUp as RequestHandler,
    // `billing.addon.prune` rides along: a tier change auto-drops any bundle the
    // destination tier now includes (applyTierIncludedAddonPrune).
    audited('billing.tier.override', 'billing.addon.prune'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const subscriptionId = getParam(req.params, 'id');
      const validation = validateBody(req, AdminSubscriptionUpdateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }
      const { planId, status, interval, cancelAtPeriodEnd } = validation.value;

      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        return sendError(res, 404, 'Subscription not found', ErrorCode.NOT_FOUND);
      }

      const orgId = subscription.orgId;
      // Attribute every override row to the acting sysadmin — this is the
      // highest-value attribution surface (a privileged cross-org write).
      // Named distinctly from the shared `actorId()` helper (imported above) so
      // it doesn't shadow it: this one stays OPTIONAL, because a `billing_events`
      // row with no actor is a legitimate system/webhook row.
      const overrideActorId = req.user?.sub;
      // Capture the pre-change status so the status block can detect a crossing
      // of the entitled/non-entitled boundary (nothing below mutates status
      // before that block).
      const prevStatus = subscription.status;

      // Mutate the in-memory doc and validate up front, but DEFER every side
      // effect (quota sync + billing_events) until AFTER the subscription is
      // persisted. Firing them before save() risks billing<->quota drift if
      // save() throws: the quota service / event log would record a change the
      // subscription document never kept.
      const deferred: Array<() => Promise<void>> = [];

      // Validate the target plan FIRST (a 404 must not reach the provider).
      const plan = planId ? await Plan.findOne({ _id: planId, isActive: true }) : null;
      if (planId && !plan) {
        return sendError(res, 404, 'Plan not found', ErrorCode.NOT_FOUND);
      }
      const intervalChanged = !!(interval && interval !== subscription.interval);

      // Push the effective `{planId}_{interval}` price to the payment provider
      // BEFORE mutating / saving the doc — mirroring the user-facing
      // PUT /subscriptions/:id (provider-first) — whenever the plan OR the billing
      // interval changes. Without this the provider keeps invoicing the OLD price
      // (or the old cadence, for an interval-only override) while the local record
      // and entitlements move on: a silent finance drift. Unlike the
      // status→terminal branch — which INTENTIONALLY leaves the provider untouched
      // (see providerUntouched note) — a price change must keep billing and
      // entitlements consistent. Provider-first also gives the user path's failure
      // contract: if updateSubscription throws, the route aborts before
      // save()/sync, so the two stores never diverge. Marketplace-metered subs
      // no-op at the provider, and a not-yet-externally-bound row (no externalId)
      // has no provider price to push, so it's skipped cleanly.
      if ((planId || intervalChanged) && subscription.externalId) {
        await getPaymentProvider().updateSubscription(
          subscription.externalId,
          planId ?? subscription.planId,
          intervalChanged ? interval : subscription.interval,
        );
      }

      if (planId && plan) {
        const oldPlanId = subscription.planId;
        subscription.planId = planId;
        const newTier = plan.tier;

        // Prune any PURE-FEATURE add-on the new tier now bundles in so the org
        // isn't double-billed for a feature its tier includes (and can't
        // self-service-remove — the tier-filtered catalog hides it). Mutates the
        // doc's addons in memory (persisted by save() below) BEFORE the deferred
        // side effects; hybrid bundles (feature AND quota) are kept.
        const pruned = applyTierIncludedAddonPrune(subscription, newTier, {
          orgId, subscriptionId: subscription._id.toString(), source: 'admin_plan_change',
        });

        // Shared post-save runner: service-token entitlement sync (never the
        // admin's bearer), the plan_changed row, and the pruned bundles' provider
        // line-item removal + addon_pruned trail. `subscription.addons` already
        // reflects the prune, so the reduced set is what syncs.
        const runPlanSideEffects = applyPlanTierChange(subscription, plan, {
          oldPlanId, newPlanId: planId, pruned, actorId: overrideActorId, source: 'admin_plan_change',
          // A sysadmin deliberately granting a tier is the one caller allowed to
          // lift a lapsed sub back to paid entitlements without a payment; every
          // other path (self-service PUT, Stripe webhook, marketplace) must not.
          allowLapsedRestore: true,
        });

        deferred.push(async () => {
          await runPlanSideEffects();
          // Mirror this privileged CROSS-TENANT tier override to the CENTRAL audit
          // trail (alongside the local plan_changed row applyPlanTierChange wrote).
          // Fire-and-forget: the sysadmin acts on ANOTHER org, so actorId = the
          // sysadmin and affectedOrgId = the target org. Details are an explicit
          // tier/plan-id whitelist — no card/payment secret or AWS account id can leak.
          getAuditClient().record({
            action: 'billing.tier.override',
            actorId: actorId({ userId }),
            affectedOrgId: orgId,
            targetId: subscriptionId,
            details: { toTier: newTier, fromPlanId: oldPlanId, toPlanId: planId },
          }, 'billing');
        });
      }

      if (status && status !== subscription.status) {
        subscription.status = status;

        // An admin status flip can change ENTITLEMENT ENFORCEMENT: the entitled
        // set (MANAGEABLE_SUBSCRIPTION_STATUSES: active/trialing/past_due-grace)
        // enforces the paid tier; terminal states (canceled/incomplete) do not.
        // Sync entitlements ONLY when the status crosses that boundary, REUSING
        // the same tier math as the normal cancel/reactivate paths — otherwise
        // the quota/platform stores keep enforcing the stale tier and the drift
        // reconciler silently re-syncs it back up, masking the admin's intent.
        const wasEntitled = isEntitledStatus(prevStatus);
        const nowEntitled = isEntitledStatus(status);

        // Crossing DOWN into a terminal status downgrades local + quota/platform
        // entitlements to baseline but INTENTIONALLY does NOT call
        // provider.cancelSubscription (unlike the provider-first POST /cancel) —
        // this is a manual admin override, so the provider subscription is left
        // untouched; use the normal cancel flow to also stop provider billing. The
        // `providerUntouched: true` note below makes that visible to finance.
        const enteringTerminal = wasEntitled && !nowEntitled;

        deferred.push(async () => {
          await createBillingEvent(
            orgId,
            'subscription_updated',
            // Tag the terminal-downgrade row so finance can see the provider sub was
            // deliberately left billing (admin override, not a provider cancel).
            { status, ...(enteringTerminal && { providerUntouched: true }) },
            subscriptionId,
            overrideActorId,
          );

          if (enteringTerminal) {
            // Into a terminal/non-entitled status: fall back to the un-subscribed
            // baseline tier with add-ons CLEARED — identical to the normal cancel
            // / grace-expiry / webhook-delete downgrade. Runs after any plan-block
            // sync above, so a contradictory plan+cancel override still lands on
            // the baseline. NOTE: provider billing is NOT stopped here (see the
            // trust-boundary comment above) — this only downgrades entitlements.
            logger.info('Admin status change downgraded entitlements to baseline tier', {
              subscriptionId, fromStatus: prevStatus, toStatus: status, tier: BASELINE_TIER,
            });
            await syncEntitlements(orgId, BASELINE_TIER, billingServiceAuth(orgId), subscriptionId, []);
          } else if (!wasEntitled && nowEntitled && !planId) {
            // Reactivation into an entitled status WITHOUT a concurrent plan change
            // — re-sync the subscription's CURRENT plan tier + purchased add-ons
            // (mirrors the webhook payment-recovery / reactivate re-upgrade). When
            // planId IS present, the plan block above already synced the new tier +
            // add-ons, so we don't double-sync here.
            const currentPlan = await Plan.findById(subscription.planId);
            if (currentPlan) {
              logger.info('Admin status change re-synced entitlements for current plan tier', {
                subscriptionId, fromStatus: prevStatus, toStatus: status, tier: currentPlan.tier,
              });
              await syncEntitlements(orgId, currentPlan.tier, billingServiceAuth(orgId), subscriptionId, subscription.addons ?? []);
            } else {
              // Plan row is missing/deleted: the org just crossed INTO an entitled
              // status but we can't resolve a tier to grant — without this branch it
              // would silently get no sync/event/log. Surface the gap (WARN + audit
              // row + metric) so support can repair the dangling planId; entitlements
              // stay at their current (un-upgraded) enforced state until then.
              logger.warn('Admin reactivation could not sync — subscription plan not found', {
                subscriptionId, planId: subscription.planId, fromStatus: prevStatus, toStatus: status,
              });
              await recordReactivatePlanMissing(orgId, subscriptionId, 'admin', {
                status, planId: subscription.planId,
              }, overrideActorId);
            }
          }
        });
      }

      if (intervalChanged) {
        const oldInterval = subscription.interval;
        subscription.interval = interval;
        deferred.push(async () => {
          await createBillingEvent(orgId, 'interval_changed', { oldInterval, newInterval: interval }, subscriptionId, overrideActorId);
        });
      }

      if (cancelAtPeriodEnd !== undefined) subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;

      // Persist first — only run side effects once the document is durably saved.
      await subscription.save();

      for (const run of deferred) {
        await run();
      }

      // Re-cadence add-on line items on an interval change — updateSubscription
      // swaps only the base item, so bundles would otherwise stay on the old
      // cadence's price (matches the user PUT path).
      if (intervalChanged && subscription.addons?.length) {
        await syncProviderAddons(
          subscription.externalId, subscription.addons, subscription.interval, orgId,
          subscriptionId, 'interval_change',
        );
      }

      ctx.log('COMPLETED', 'Admin updated subscription', { subscriptionId, planId, status });

      return sendSuccess(res, 200, {
        subscription: buildSubscriptionResponse(subscription),
      });
    }, { requireOrgId: false }),
  );

  // GET /billing/subscriptions/by-org/:orgId/billable — org-move guard.
  // Sysadmin / service-token only. Answers whether the org still holds a
  // billable (manageable) subscription, so the platform refuses to nest a paying
  // root under another account — pooled billing would otherwise leave that
  // subscription charging for an org that no longer owns its plan. Read-only.
  router.get(
    '/subscriptions/by-org/:orgId/billable',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res }) => {
      const targetOrgId = getParam(req.params, 'orgId');
      if (!targetOrgId) return sendError(res, 400, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);
      const billable = await Subscription.exists({
        orgId: targetOrgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
      });
      return sendSuccess(res, 200, { billable: !!billable });
    }, { requireOrgId: false }),
  );

  // DELETE /billing/subscriptions/by-org/:orgId — org-cascade hook.
  // Sysadmin / service-token only. Cancels and removes every subscription
  // + event for the org. Idempotent: missing org → 200 with `deleted: 0`.
  //
  // The platform's org-cascade-service calls this with a service-minted
  // token; user-initiated org deletes never reach this path (they go
  // through admin.org.delete on platform, which fires us internally).
  router.delete(
    '/subscriptions/by-org/:orgId',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    audited('billing.subscription.delete'),
    withRoute(async ({ req, res, userId }) => {
      const targetOrgId = getParam(req.params, 'orgId');
      if (!targetOrgId) return sendError(res, 400, 'orgId is required', ErrorCode.MISSING_REQUIRED_FIELD);

      // Cancel every still-billable subscription at the provider first so we
      // don't leave billable state running after our local rows are gone.
      // A trialing / past_due row carries a live externalId at the provider
      // just like an active one; cancelling only status:'active' meant the
      // deleteMany below wiped the local row while the provider kept billing,
      // with nothing left to reconcile. Match the manageable (non-terminal)
      // set so the provider-cancel covers what deleteMany removes. Fail-soft:
      // a provider-cancel failure is logged but never blocks the local cascade.
      // An org realistically holds a single active subscription; a hard cap
      // keeps this cascade sweep bounded even against pathological data (the
      // provider-cancel loop + audit mirror below iterate this set).
      const billable = await Subscription.find({
        orgId: targetOrgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
      }).limit(1000);
      for (const sub of billable) {
        if (sub.externalId) {
          try {
            await getPaymentProvider().cancelSubscription(sub.externalId);
          } catch (err) {
            logger.warn('Provider cancel failed during cascade — continuing with local delete', {
              orgId: targetOrgId,
              subscriptionId: sub._id?.toString(),
              error: errorMessage(err),
            });
          }
        }
      }

      const subDelete = await Subscription.deleteMany({ orgId: targetOrgId });

      // Drop billing events too — they're scoped to the org and have no
      // independent purpose once the subscription is gone. Audit retention
      // lives in platform's audit_events collection, not here.
      const eventDelete = await BillingEvent.deleteMany({ orgId: targetOrgId });

      // Mirror each removed (billable) subscription to the CENTRAL audit trail,
      // ALONGSIDE the local billing_events rows we just dropped. Fire-and-forget;
      // details are an explicit id-only whitelist so no provider/card secret or
      // AWS account id leaks. `billable` holds the org's live (non-terminal)
      // subscription(s) loaded before deletion, each carrying its own id + plan.
      for (const sub of billable) {
        getAuditClient().record({
          action: 'billing.subscription.delete',
          actorId: actorId({ userId }),
          orgId: targetOrgId,
          targetId: sub._id?.toString(),
          details: { planId: sub.planId, orgId: targetOrgId },
        }, 'billing');
      }

      logger.info('Subscription cascade complete', {
        orgId: targetOrgId,
        subscriptions: subDelete.deletedCount ?? 0,
        events: eventDelete.deletedCount ?? 0,
      });

      return sendSuccess(res, 200, {
        deleted: subDelete.deletedCount ?? 0,
        events: eventDelete.deletedCount ?? 0,
      });
    }, { requireOrgId: false }),
  );

  // GET /billing/admin/events — list billing events

  router.get(
    '/admin/events',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requireSystemAdmin as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const limit = parseQueryIntClamped(req.query.limit, 50, 200);
      const offset = parseQueryInt(req.query.offset, 0);
      const orgId = parseQueryString(req.query.orgId);

      const filter: Record<string, unknown> = {};
      if (orgId) filter.orgId = orgId;

      const [events, total] = await Promise.all([
        BillingEvent.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        BillingEvent.countDocuments(filter),
      ]);

      const result = events.map(toBillingEventResponse);

      ctx.log('COMPLETED', 'Listed billing events', { total, limit, offset });
      return sendSuccess(res, 200, { events: result, total, limit, offset });
    }, { requireOrgId: false }),
  );

  // GET /billing/events — the CALLER's own billing events (credit/discount/combo/
  // subscription activity), so a customer can see its usage-credit movement rather
  // than it being sysadmin-only. Scoped to the caller's org (never a `?orgId=`).
  router.get(
    '/events',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requirePermission('billing:read') as RequestHandler,
    withRoute(async ({ req, res, orgId }) => {
      const limit = parseQueryIntClamped(req.query.limit, 50, 200);
      const offset = parseQueryInt(req.query.offset, 0);
      const [events, total] = await Promise.all([
        BillingEvent.find({ orgId }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        BillingEvent.countDocuments({ orgId }),
      ]);
      const result = events.map(toBillingEventResponse);
      return sendSuccess(res, 200, { events: result, total, limit, offset });
    }),
  );

  return router;
}
