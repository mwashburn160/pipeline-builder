// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Add-on prune + plan-tier-change orchestration — the tier-included add-on
 * pruning finalizer and the plan-change side-effect runner. Split out of the
 * (large) billing-helpers module; imports its shared deps from there ONE-WAY
 * (billing-helpers never imports this file, so there's no cycle).
 */
import { createLogger, type QuotaTier } from '@pipeline-builder/api-core';
import type { BillingInterval } from '../models/subscription.js';
import type { BillingEventType } from '../models/billing-event.js';
import { getAuditClient } from '../services/audit.js';
import {
  billingServiceAuth,
  createBillingEvent,
  getBundleCatalog,
  pruneTierIncludedFeatureAddons,
  syncEntitlements,
  syncProviderAddons,
  type PrunedAddon,
} from './billing-helpers.js';

const logger = createLogger('billing-addon-prune');

/** Context threaded into the tier-included add-on prune helpers — for logging, the
 *  billing_events / central-audit trail, and the provider line-item removal. */
export interface AddonPruneContext {
  orgId: string;
  subscriptionId: string;
  /** Current billing cadence — selects the provider price when removing lines. */
  interval: BillingInterval;
  /** Provider subscription id; absent (or a no-op provider) ⇒ removal is skipped. */
  externalId?: string | null;
  /** Acting user (JWT `sub`) when a request context exists; undefined on system
   *  paths (webhook / marketplace SNS) — we never fabricate an actor. */
  actorId?: string;
  /** Short label of the triggering flow, for the INFO log (e.g. 'plan_change'). */
  source: string;
}

/**
 * Apply the tier-included pure-feature add-on prune to a subscription document
 * IN MEMORY: compute the reduced add-on list via {@link pruneTierIncludedFeatureAddons},
 * assign it to `subscription.addons` (so the caller's own `save()` persists it),
 * log each dropped bundle, and return the pruned list. Does NO external I/O, so it
 * is safe to run BEFORE the caller's save(); the side effects (provider line-item
 * removal + billing_events + audit) live in {@link finalizePrunedAddons}, which
 * the caller runs AFTER save so a failed save can't leave the provider or audit
 * trail ahead of the persisted document.
 *
 * The four tier-change sites (self-service PUT, admin override, marketplace
 * entitlement update, Stripe webhook plan change) all funnel through this pair so
 * the prune wiring — and its double-billing fix — live in exactly one place.
 */
export function applyTierIncludedAddonPrune(
  subscription: { addons?: Array<{ bundleId: string; quantity: number }> },
  newTier: QuotaTier,
  ctx: Pick<AddonPruneContext, 'orgId' | 'subscriptionId' | 'source'>,
): PrunedAddon[] {
  const { addons, pruned } = pruneTierIncludedFeatureAddons(
    subscription.addons ?? [], newTier, getBundleCatalog(),
  );
  if (pruned.length === 0) return [];
  subscription.addons = addons;
  for (const p of pruned) {
    logger.info('Pruned tier-included feature add-on', {
      orgId: ctx.orgId,
      subscriptionId: ctx.subscriptionId,
      bundleId: p.bundleId,
      features: p.features,
      tier: newTier,
      source: ctx.source,
    });
  }
  return pruned;
}

/**
 * Side effects for an auto-prune, run by the caller AFTER `subscription.save()`.
 * For every bundle {@link applyTierIncludedAddonPrune} dropped: write a local
 * `billing_events` row (`reason: 'addon_pruned'`, mirroring a user-initiated
 * `addon_removed`) and mirror it to the central audit trail, so finance/support
 * can reconcile a charge that stopped without a user action. Then delete the
 * dropped bundles' PROVIDER line items via the SAME path a user-initiated removal
 * uses ({@link syncProviderAddons} with the reduced list) — identical proration —
 * so the customer stops being invoiced. Without this, the prune only dropped local
 * tracking and the Stripe line item kept billing (the double-billing bug).
 *
 * `reducedAddons` is the KEPT set (`subscription.addons` after the prune);
 * syncProviderAddons rebuilds the provider's bundle line items from it, dropping
 * exactly the pruned bundles. Marketplace is EXEMPT from the provider removal:
 * its add-ons are AWS-metered (its `syncAddons` no-ops), so there is no line item
 * to delete — but the local event + central audit still record the drop.
 *
 * No-op when nothing was pruned. Best-effort throughout (never throws): the
 * subscription mutation already succeeded regardless.
 */
export async function finalizePrunedAddons(
  pruned: readonly PrunedAddon[],
  reducedAddons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  ctx: AddonPruneContext,
): Promise<void> {
  if (pruned.length === 0) return;
  for (const p of pruned) {
    await createBillingEvent(
      ctx.orgId,
      'subscription_updated',
      { reason: 'addon_pruned', bundleId: p.bundleId, features: p.features },
      ctx.subscriptionId,
      ctx.actorId,
    );
    // Mirror to the central trail alongside the local row via the DEDICATED
    // `billing.addon.prune` action (distinct from the user-initiated
    // `billing.addon.remove` sibling — a prune is a system-driven auto-removal of
    // a tier-included bundle). Still tagged with `reason: 'addon_pruned'`;
    // actorId is 'system' on the auto-prune paths. Id/feature whitelist only, so
    // no card/payment secret or AWS account id can leak. Fire-and-forget.
    getAuditClient().record({
      action: 'billing.addon.prune',
      actorId: ctx.actorId ?? 'system',
      orgId: ctx.orgId,
      targetId: p.bundleId,
      details: { reason: 'addon_pruned', bundleId: p.bundleId, features: p.features, subscriptionId: ctx.subscriptionId },
    }, 'billing');
  }
  // Remove the dropped bundles' provider line items through the same call the
  // user-initiated removal uses (identical proration). No-op for marketplace.
  // Thread subscriptionId + source so a Stripe failure sets the durable
  // providerAddonSyncPending marker (reconciler re-drives it) + meters under
  // this prune source.
  await syncProviderAddons(ctx.externalId, reducedAddons, ctx.interval, ctx.orgId, ctx.subscriptionId, ctx.source);
}

/** Minimal subscription shape the shared tier-change side-effect runner reads. */
interface PlanTierChangeSubscription {
  _id: { toString(): string };
  orgId: string;
  interval: BillingInterval;
  externalId?: string | null;
  addons?: Array<{ bundleId: string; quantity: number }>;
}

/** Options for {@link applyPlanTierChange}. */
export interface PlanTierChangeOptions {
  /** Plan id BEFORE the change (for the plan_changed event detail). */
  oldPlanId: string;
  /** Plan id AFTER the change. */
  newPlanId: string;
  /** Bundles {@link applyTierIncludedAddonPrune} dropped (pre-save), finalized here. */
  pruned: readonly PrunedAddon[];
  /** Acting user (JWT `sub`); undefined on system paths (webhook/SNS/cron). */
  actorId?: string;
  /** Short label of the triggering flow (e.g. 'plan_change', 'stripe_plan_change'). */
  source: string;
  /**
   * Real bearer to thread. Undefined ⇒ a service token is minted for the org
   * ({@link billingServiceAuth}); `''` is passed straight through to
   * `syncEntitlements`, which mints its own — preserving each caller's original
   * auth. Never a user credential (see the create-subscription rationale).
   */
  authHeader?: string;
  /** Extra provider-specific fields merged into the default plan_changed detail
   *  (e.g. Stripe's `provider`/`source`/`interval`, marketplace's `customerIdentifier`). */
  eventDetails?: Record<string, unknown>;
  /**
   * Override the emitted billing_event entirely. Used by the Stripe webhook when
   * ONLY the billing interval changed (same plan/tier): record it as an
   * `interval_changed` event instead of a `plan_changed` whose oldPlanId ===
   * newPlanId. When omitted, a `plan_changed` row is written.
   */
  event?: { type: BillingEventType; details: Record<string, unknown> };
}

/**
 * Shared POST-SAVE side-effect bundle for the four tier-change sites (self-service
 * PUT, admin override, Stripe webhook plan change, marketplace entitlement update):
 * sync effective entitlements → write the `plan_changed` billing_events row →
 * finalize the tier-included add-on prune (provider line-item removal + central
 * audit, via {@link finalizePrunedAddons}).
 *
 * Returns a DEFERRED thunk (nothing runs inline). Callers invoke it AFTER
 * `subscription.save()` so a failed save can't leave the quota service, event log,
 * or provider ahead of the persisted document — the admin path already defers
 * every side effect for exactly this reason, and this factors that pattern so no
 * site can drift (forget `subscription.addons ?? []`, mint the wrong service
 * token, or emit a divergent event shape). The pre-save doc mutation + prune (set
 * planId, capture oldPlanId, {@link applyTierIncludedAddonPrune}) stay at the call
 * site. The admin path's own `billing.tier.override` central-audit record is NOT
 * part of this bundle — it stays inline (a distinct cross-tenant attribution).
 */
export function applyPlanTierChange(
  subscription: PlanTierChangeSubscription,
  plan: { tier: QuotaTier },
  opts: PlanTierChangeOptions,
): () => Promise<void> {
  const orgId = subscription.orgId;
  const subscriptionId = subscription._id.toString();
  return async () => {
    // undefined ⇒ mint a service token; '' ⇒ let syncEntitlements mint (marketplace).
    const auth = opts.authHeader ?? billingServiceAuth(orgId);
    await syncEntitlements(orgId, plan.tier, auth, subscriptionId, subscription.addons ?? []);
    if (opts.event) {
      await createBillingEvent(orgId, opts.event.type, opts.event.details, subscriptionId, opts.actorId);
    } else {
      await createBillingEvent(
        orgId, 'plan_changed',
        { oldPlanId: opts.oldPlanId, newPlanId: opts.newPlanId, ...opts.eventDetails },
        subscriptionId, opts.actorId,
      );
    }
    await finalizePrunedAddons(opts.pruned, subscription.addons ?? [], {
      orgId,
      subscriptionId,
      interval: subscription.interval,
      externalId: subscription.externalId,
      actorId: opts.actorId,
      source: opts.source,
    });
  };
}
