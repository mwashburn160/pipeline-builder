// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Add-on prune + plan-tier-change orchestration: the pure tier-included add-on
 * prune, the provider line-item leg (with its durable retry marker), the prune
 * finalizer, and the plan-change side-effect runner.
 */
import { SYSTEM_ACTOR_ID, createLogger, errorMessage, TIER_FEATURES, type QuotaTier, recordAudit } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { BundleConfig } from '../config/billing-types.js';
import { cascadeRemoveDependents } from './addon-catalog.js';
import { billingServiceAuth, createBillingEvent, getBundleCatalog } from './billing-helpers.js';
import { syncEntitlements } from './entitlement-sync.js';
import { isGraceDowngraded } from './subscription-status.js';
import type { BillingEventType } from '../models/billing-event.js';
import { Subscription, type BillingInterval } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('billing-addon-prune');

/** An add-on removed because the destination tier now includes its feature. */
export interface PrunedAddon {
  bundleId: string;
  features: string[];
}

/** Result of pruning tier-included pure-feature add-ons off a subscription. */
export interface PruneResult {
  /** The reduced add-on list to persist + sync. */
  addons: Array<{ bundleId: string; quantity: number }>;
  /** The add-ons that were dropped (for logging / audit). */
  pruned: PrunedAddon[];
}

/**
 * Drop any PURE-FEATURE add-on bundle whose granted feature is now included in
 * the destination tier's feature set (docs/billing-bundles.md). Prevents
 * double-billing: a Pro/Team account that bought e.g. `advanced_reporting` or
 * `team_usage_analytics` and then upgrades into a tier that bundles that feature keeps
 * paying for the now-redundant add-on, and the tier-filtered `/bundles` catalog
 * hides it (its `availableForTiers` excludes the higher tier) so they can't
 * self-service-remove it.
 *
 * Prune predicate (applied per add-on): the add-on's bundle exists in the
 * catalog AND has NO quota grants (`Object.keys(bundle.grants).length === 0`)
 * AND every flag in `bundle.features` is present in `TIER_FEATURES[newTier]`.
 * HYBRID bundles — ones that grant a feature AND a quota — are NEVER pruned:
 * dropping them would strip the paid quota along with the redundant feature. No
 * shipped bundle is hybrid today (the last one, `sso`, was withdrawn when SSO
 * became Team-and-above only), but the rule is structural, not a special case,
 * so a future hybrid pack can't be silently deleted by a tier upgrade.
 * Quota-only packs (seat, pipeline_pack, etc.) carry no features and are never
 * pruned.
 *
 * Pure function (no I/O) so callers persist + sync the reduced list themselves.
 */
export function pruneTierIncludedFeatureAddons(
  addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  newTier: QuotaTier,
  catalog: readonly BundleConfig[],
): PruneResult {
  const tierFeatures = new Set<string>(TIER_FEATURES[newTier] ?? []);
  const byId = new Map(catalog.map((b) => [b.id, b]));
  const kept: Array<{ bundleId: string; quantity: number }> = [];
  const pruned: PrunedAddon[] = [];

  for (const addon of addons) {
    const bundle = byId.get(addon.bundleId);
    const features = bundle?.features ?? [];
    const isPureFeatureBundle = Boolean(bundle)
      && Object.keys(bundle!.grants).length === 0
      && features.length > 0
      && features.every((f) => tierFeatures.has(f));
    if (isPureFeatureBundle) {
      pruned.push({ bundleId: addon.bundleId, features: [...features] });
    } else {
      kept.push(addon);
    }
  }

  return { addons: kept, pruned };
}

/**
 * Best-effort: reconcile the external provider's add-on line items to `addons`
 * (the target/reduced set). Local entitlements are already applied, so a provider
 * error must not fail the request — it's logged and reconciled on the next
 * change/webhook. No-ops when there is no external subscription id, and when the
 * active provider has no line-item add-ons (marketplace/stub `syncAddons` is a
 * no-op — marketplace add-ons are AWS-metered, not pushed as line items).
 *
 * The single provider path shared by the user-initiated add/remove routes
 * (routes/addons) AND the auto-prune finalizer ({@link finalizePrunedAddons}), so
 * a bundle's line item is always deleted through ONE call with identical
 * proration behavior.
 */
export async function syncProviderAddons(
  externalId: string | null | undefined,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  interval: BillingInterval,
  orgId: string,
  subscriptionId?: string,
  source = 'addon_change',
): Promise<void> {
  if (!externalId) return;
  try {
    await getPaymentProvider().syncAddons?.(externalId, addons, interval);
    // Success — clear any durable marker a prior failed attempt left so the
    // lifecycle reconciler stops re-driving it. (No-op for marketplace, whose
    // syncAddons never fails, so the marker is never set there in the first place.)
    await setProviderAddonSyncPending(subscriptionId, orgId, false);
  } catch (err) {
    logger.warn('Provider add-on sync failed (local entitlements already applied)', { orgId, error: errorMessage(err) });
    // Meter every provider add-on sync failure so SRE can alert — covers BOTH the
    // user add/remove path and the auto-prune finalizer via `source`.
    incCounter('billing_provider_addon_sync_failed_total', { source });
    // Durable marker so the lifecycle reconciler re-drives the removal from the
    // CURRENT reduced add-on list — otherwise a transient Stripe failure during a
    // tier upgrade leaves the customer billed for the pruned bundle forever
    // (invisibly). This is the provider leg's own recovery; the entitlement leg
    // recovers separately via the durable event-bus retry.
    await setProviderAddonSyncPending(subscriptionId, orgId, true);
  }
}

/**
 * Set/clear the durable `metadata.providerAddonSyncPending` marker on a
 * Subscription — the provider leg's own durable-retry signal (the entitlement
 * leg instead retries via the event bus). When
 * {@link syncProviderAddons} fails to reconcile a Stripe line item (e.g. a
 * transient outage during a tier-upgrade prune), the removal is only local; this
 * marker lets the lifecycle reconciler re-drive the removal so the customer stops
 * being billed for a bundle they no longer have. Only Stripe-backed subs reach
 * here with a failure (syncProviderAddons no-ops without an externalId, and the
 * marketplace `syncAddons` is a no-op that never throws), so the marker is
 * effectively Stripe-only. Surgical dot-path $set/$unset so a concurrent metadata
 * write (grace/renewal/pending markers) isn't clobbered. Best-effort + swallowed:
 * it can NOT alter syncProviderAddons's fail-open contract.
 */
async function setProviderAddonSyncPending(
  subscriptionId: string | undefined,
  orgId: string,
  pending: boolean,
): Promise<void> {
  if (!subscriptionId) return;
  try {
    await Subscription.updateOne(
      { _id: subscriptionId },
      pending
        ? { $set: { 'metadata.providerAddonSyncPending': true } }
        : { $unset: { 'metadata.providerAddonSyncPending': '' } },
    );
  } catch (err) {
    logger.warn('Failed to persist providerAddonSyncPending marker', {
      orgId, subscriptionId, error: errorMessage(err),
    });
  }
}

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
  const catalog = getBundleCatalog();
  const included = pruneTierIncludedFeatureAddons(subscription.addons ?? [], newTier, catalog);
  // A tier change can also strand a bundle whose PREREQUISITE the new tier no
  // longer provides (e.g. Enterprise → Team drops the tier-included
  // advanced_reporting, so a held DORA History Pack has nothing to extend). Those
  // are dropped the same way — the account would otherwise keep paying for a
  // pack that does nothing.
  const cascade = cascadeRemoveDependents(included.addons, catalog, newTier);
  const byId = new Map(catalog.map((b) => [b.id, b]));
  const addons = cascade.addons;
  const pruned: PrunedAddon[] = [
    ...included.pruned,
    ...cascade.removed.map((bundleId) => ({ bundleId, features: [...(byId.get(bundleId)?.features ?? [])] })),
  ];
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
    recordAudit({
      action: 'billing.addon.prune',
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      orgId: ctx.orgId,
      targetId: p.bundleId,
      details: { reason: 'addon_pruned', bundleId: p.bundleId, features: p.features, subscriptionId: ctx.subscriptionId },
    });
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
  /** Carries `gracePeriodDowngradedAt` — see `allowLapsedRestore`. */
  metadata?: Record<string, unknown> | null;
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
  /**
   * Let this change hand the paid tier back to a subscription whose dunning
   * grace already LAPSED (`metadata.gracePeriodDowngradedAt`).
   *
   * Defaults to false, which is the safe direction: `past_due` stays manageable
   * after the grace downgrade so the customer can fix their billing, and a plan
   * change from that state would otherwise re-sync the plan's nominal tier and
   * restore paid entitlements without a payment — permanently, since the drift
   * reconciler skips `past_due` rows. The Stripe webhook is authoritative about
   * WHICH plan the sub is on, not about whether the invoice was paid, so it
   * keeps the default too; `handlePaymentSucceeded` clears the marker on real
   * recovery. Only the sysadmin override opts out, because that is a human
   * deliberately granting a tier.
   */
  allowLapsedRestore?: boolean;
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
    // A sub whose grace already lapsed has been synced down to `developer` with
    // no add-ons; pushing `plan.tier` here would restore the paid tier for free.
    // See `allowLapsedRestore`.
    const lapsed = isGraceDowngraded(subscription) && !opts.allowLapsedRestore;
    await syncEntitlements(
      orgId,
      lapsed ? 'developer' : plan.tier,
      auth,
      subscriptionId,
      lapsed ? [] : (subscription.addons ?? []),
    );
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
