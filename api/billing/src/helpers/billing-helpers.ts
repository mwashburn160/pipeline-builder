// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaTier } from '@pipeline-builder/api-core';
import { createLogger, createSafeClient, errorMessage, getServiceAuthHeader, TIER_FEATURES, VALID_QUOTA_TYPES } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config, effectiveEntitlements, type BillingConfig, type BundleConfig } from '@pipeline-builder/pipeline-core';
import { config } from '../config.js';
import { fetchQuotaTypeUsage, fetchSeatUsage } from './quota-client.js';
import { BillingEvent } from '../models/billing-event.js';
import type { BillingEventType } from '../models/billing-event.js';
import { Subscription } from '../models/subscription.js';
import type { BillingInterval } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { getAuditClient } from '../services/audit.js';

const logger = createLogger('billing-helpers');

// Re-export so callers can keep importing from billing-helpers, but the
// canonical declaration lives with the Mongoose model.
export type { BillingInterval };

/**
 * Non-terminal subscription statuses a user may still SEE and MANAGE.
 *
 * `active`/`trialing` are entitlement-worthy; `past_due` is the dunning grace
 * window (entitlements still enforced until the grace period lapses). All three
 * must remain visible on GET and mutable via cancel/PUT/reactivate/add-ons — a
 * trial customer has to be able to cancel before conversion, and a past_due
 * customer has to be able to stop dunning. Terminal / never-provisioned states
 * (`canceled`, `incomplete`) are deliberately excluded.
 */
export const MANAGEABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/** Resolve the per-request timeout for billing's outbound service calls. */
export function getBillingTimeout(): number {
  const server = Config.get('server') as { services?: { billingTimeout?: number } } | undefined;
  return server?.services?.billingTimeout ?? 5000;
}

/**
 * Calculate the end date for a billing period.
 */
export function calculatePeriodEnd(start: Date, interval: BillingInterval): Date {
  const end = new Date(start);
  if (interval === 'annual') {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

/**
 * Create a billing event for audit logging.
 *
 * `actorId` is the id (JWT `sub`) of the user who initiated the change, threaded
 * from request-context call sites (subscriptions/addons/admin routes). System /
 * non-request paths (webhook, lifecycle cron, marketplace SNS) have no user
 * actor and leave it undefined — we never fabricate one. `details` must never
 * carry payment tokens or PII (see the model comment).
 */
export async function createBillingEvent(
  orgId: string,
  type: BillingEventType,
  details: Record<string, unknown> = {},
  subscriptionId?: string,
  actorId?: string,
): Promise<void> {
  try {
    await BillingEvent.create({ orgId, type, details, subscriptionId, actorId });
  } catch (error) {
    logger.error('Failed to create billing event', { orgId, type, error });
    // Surface audit-write failures on a counter so SRE can alert. Don't
    // change error behavior — billing flows continue regardless.
    incCounter('billing_event_write_failed_total', { type });
  }
}

/**
 * Sync organization tier to the quota service after a subscription change.
 *
 * `authHeader` is optional — webhook / lifecycle / SNS paths have no user
 * context and should pass `''`. In that case we mint a service token (which
 * satisfies the quota service's system-admin gate). User-initiated paths
 * (POST /subscriptions, PUT /admin) pass through their bearer.
 *
 * On failure, writes a `billing_events` audit row so support can see that
 * the local DB drifted from the quota service. The audit write itself is
 * best-effort and never throws.
 */
export async function syncTierToQuotaService(
  orgId: string,
  tier: QuotaTier,
  authHeader: string,
  subscriptionId?: string,
  quotas?: Record<string, number>,
): Promise<boolean> {
  try {
    const client = createSafeClient({
      host: config.quotaService.host,
      port: config.quotaService.port,
      timeout: getBillingTimeout(),
    });

    // Mint the service token for the target org so the quota service sees a
    // real tenant identity rather than 'system' — keeps RLS / audit logs
    // attributable to the org being mutated. Push EXPLICIT effective limits
    // (tier + bundles) so a plain tier reseed can't wipe purchased add-ons.
    const effectiveAuth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
    const body = quotas ? { tier, quotas } : { tier };
    const response = await client.put(`/quotas/${orgId}`, body, {
      headers: {
        'Authorization': effectiveAuth,
        'x-org-id': orgId,
      },
    });

    if (response && response.statusCode < 400) {
      logger.info('Synced tier to quota service', { orgId, tier });
      return true;
    }

    logger.error('Failed to sync tier to quota service', {
      orgId, tier, statusCode: response?.statusCode,
    });
    await createBillingEvent(orgId, 'subscription_updated', {
      reason: 'quota_sync_failed',
      tier,
      statusCode: response?.statusCode,
    }, subscriptionId);
    return false;
  } catch (error) {
    logger.error('Error syncing tier to quota service', { orgId, tier, error });
    await createBillingEvent(orgId, 'subscription_updated', {
      reason: 'quota_sync_failed',
      tier,
      error: error instanceof Error ? error.message : String(error),
    }, subscriptionId);
    return false;
  }
}

/**
 * Push the effective SEAT limit to the platform service. Seats are platform-
 * owned (not a quota-service type — see docs/org-team-hierarchy.md §3a), so
 * they can't ride the quota sync. `seats` is the EFFECTIVE limit (tier +
 * bundles). Best-effort with an audit row on failure; platform resolves the org
 * to its root.
 */
async function pushSeatLimitToPlatform(
  orgId: string,
  seats: number,
  features: string[],
  authHeader: string,
  subscriptionId?: string,
  tier?: QuotaTier,
): Promise<boolean> {
  try {
    const client = createSafeClient({
      host: config.platformService.host,
      port: config.platformService.port,
      timeout: getBillingTimeout(),
    });
    const effectiveAuth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
    // Push the account `tier` alongside seats/features so a plan DOWNGRADE
    // invalidates stale JWTs platform-side (the token re-derives tier-included
    // features from `org.tier`). Platform sets ONLY the tier label here — it
    // never reseeds quotas (billing owns limits, synced to the quota service).
    const response = await client.put(`/organization/${orgId}/seat-limit`, { seats, features, tier }, {
      headers: { 'Authorization': effectiveAuth, 'x-org-id': orgId },
    });
    if (response && response.statusCode < 400) {
      logger.info('Synced seat limit to platform', { orgId, seats });
      return true;
    }
    logger.error('Failed to sync seat limit to platform', { orgId, seats, statusCode: response?.statusCode });
    await createBillingEvent(orgId, 'subscription_updated', {
      reason: 'seat_sync_failed', seats, statusCode: response?.statusCode,
    }, subscriptionId);
    return false;
  } catch (error) {
    logger.error('Error syncing seat limit to platform', { orgId, seats, error });
    // Symmetry with the non-2xx branch above (and syncTierToQuotaService): write a
    // `seat_sync_failed` audit row so support can see the local billing state
    // drifted from platform even when the call THREW rather than returned non-2xx.
    await createBillingEvent(orgId, 'subscription_updated', {
      reason: 'seat_sync_failed',
      seats,
      error: error instanceof Error ? error.message : String(error),
    }, subscriptionId);
    return false;
  }
}

/** The active add-on bundle catalog (env-driven, from pipeline-core config). */
export function getBundleCatalog(): readonly BundleConfig[] {
  return (Config.get('billing') as BillingConfig | undefined)?.bundles ?? [];
}

/** Whether purchasable add-on bundles are enabled (`BILLING_BUNDLES_ENABLED`). */
export function bundlesEnabled(): boolean {
  return (process.env.BILLING_BUNDLES_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Whether in-app bundle *self-service* is allowed. AWS Marketplace is
 * entitlement/SNS-driven — the app can't push add-on line items (its lifecycle
 * methods are all no-ops), so applying local entitlements would grant uncharged
 * capacity. Marketplace customers manage add-ons in AWS (metered dimensions);
 * self-service add/remove is Stripe/stub only.
 */
export function bundleSelfServiceAllowed(): boolean {
  return bundlesEnabled() && config.billingProvider !== 'aws-marketplace';
}

// The canonical `effectiveEntitlements` (tier base + Σ bundle grants) now lives
// in pipeline-core alongside the plan/bundle config it operates on. Re-exported
// here so existing billing importers (routes/addons) keep their import path.
export { effectiveEntitlements };

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
 * `audit_log` and then upgrades into a tier that bundles that feature keeps
 * paying for the now-redundant add-on, and the tier-filtered `/bundles` catalog
 * hides it (its `availableForTiers` excludes the higher tier) so they can't
 * self-service-remove it.
 *
 * Prune predicate (applied per add-on): the add-on's bundle exists in the
 * catalog AND has NO quota grants (`Object.keys(bundle.grants).length === 0`)
 * AND every flag in `bundle.features` is present in `TIER_FEATURES[newTier]`.
 * HYBRID bundles that also grant a quota (e.g. `sso` → `idpConfigs:5`) are NEVER
 * pruned — dropping them would strip the paid quota. Quota-only packs
 * (seat_pack, etc.) carry no features and are never pruned.
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
): Promise<void> {
  if (!externalId) return;
  try {
    await getPaymentProvider().syncAddons?.(externalId, addons, interval);
  } catch (err) {
    logger.warn('Provider add-on sync failed (local entitlements already applied)', { orgId, error: errorMessage(err) });
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
    // Mirror to the central trail alongside the local row. Reuse the sibling
    // `billing.addon.remove` action (a prune IS a system-driven add-on removal;
    // the central RemoteAuditAction union has no dedicated prune verb) and tag it
    // with `reason: 'addon_pruned'` so it's distinguishable from a user removal —
    // actorId is 'system' on the auto-prune paths too. Id/feature whitelist only,
    // so no card/payment secret or AWS account id can leak. Fire-and-forget.
    getAuditClient().record({
      action: 'billing.addon.remove',
      actorId: ctx.actorId ?? 'system',
      orgId: ctx.orgId,
      targetId: p.bundleId,
      details: { reason: 'addon_pruned', bundleId: p.bundleId, features: p.features, subscriptionId: ctx.subscriptionId },
    }, 'billing');
  }
  // Remove the dropped bundles' provider line items through the same call the
  // user-initiated removal uses (identical proration). No-op for marketplace.
  await syncProviderAddons(ctx.externalId, reducedAddons, ctx.interval, ctx.orgId);
}

/** A count-quota that would be over its (reduced) cap after an add-on change. */
export interface Overage {
  quotaType: string;
  currentUsage: number;
  targetCap: number;
  overage: number;
}

/**
 * Whether applying `newAddons` would drop a COUNT quota's cap below current
 * pooled usage (docs/billing-bundles.md §8). Guards seats (platform),
 * plugins/pipelines (quota) — these can't auto-shrink. Rate-based quotas
 * (apiCalls/aiCalls/storage) are NOT guarded (they reset / fail-closed on new
 * consumption). Returns the overages (empty = safe). Fail-open on a usage-read
 * error (a transient outage must not block the user's explicit removal).
 */
export async function checkEntitlementOvercap(
  orgId: string,
  tier: QuotaTier,
  newAddons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  authHeader: string,
): Promise<Overage[]> {
  const { limits } = effectiveEntitlements(tier, newAddons, getBundleCatalog());
  const auth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
  const overages: Overage[] = [];

  if (limits.seats !== -1) {
    // Seats are platform-owned (`data.used` on seat-usage) — read via the
    // shared quota-client so this guard can't drift from the other seat readers.
    const seatSnapshot = await fetchSeatUsage(orgId, auth);
    const used = seatSnapshot?.used ?? null;
    if (used !== null && used > limits.seats) {
      overages.push({ quotaType: 'seats', currentUsage: used, targetCap: limits.seats, overage: used - limits.seats });
    }
  }
  for (const field of ['plugins', 'pipelines'] as const) {
    if (limits[field] === -1) continue;
    const used = await fetchQuotaTypeUsage(orgId, field, auth);
    if (used !== null && used > limits[field]) {
      overages.push({ quotaType: field, currentUsage: used, targetCap: limits[field], overage: used - limits[field] });
    }
  }
  return overages;
}

/**
 * Sync an account's EFFECTIVE entitlements (tier + add-on bundles) with a
 * TWO-TARGET fan-out (docs/billing-bundles.md §5): the 9 tracked quota limits go
 * to the quota service; SEATS go to platform (quota has no `seats`). Both target
 * the subscription's org (root-scoped). Returns true only if both legs succeed.
 */
export async function syncEntitlements(
  orgId: string,
  tier: QuotaTier,
  authHeader: string,
  subscriptionId?: string,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }> = [],
): Promise<boolean> {
  const { limits, features } = effectiveEntitlements(tier, addons, getBundleCatalog());
  // The 9 tracked types go to quota; `seats` + purchased feature entitlements
  // go to platform (platform owns both).
  const tracked: Record<string, number> = {};
  for (const t of VALID_QUOTA_TYPES) tracked[t] = limits[t];

  const [quotaOk, seatOk] = await Promise.all([
    syncTierToQuotaService(orgId, tier, authHeader, subscriptionId, tracked),
    pushSeatLimitToPlatform(orgId, limits.seats, features, authHeader, subscriptionId, tier),
  ]);

  const ok = quotaOk && seatOk;
  if (!ok) {
    // Every caller currently fires-and-forgets this result — the user's
    // subscription mutation succeeds regardless (by design). Centralise the
    // failure observability here so a swallowed return can't hide entitlement
    // drift: log at error level AND emit a distinct, aggregatable metric so SRE
    // can alert + reconcile. The failing leg(s) also wrote a `billing_events`
    // audit row (reason quota_sync_failed / seat_sync_failed) inside
    // syncTierToQuotaService / pushSeatLimitToPlatform, so the drift is both
    // metered and auditable without failing the request.
    const leg = !quotaOk && !seatOk ? 'both' : !quotaOk ? 'quota' : 'seat';
    logger.error('Entitlement sync incomplete — local billing state may have drifted from quota/platform', {
      orgId, tier, subscriptionId, quotaOk, seatOk, leg,
    });
    incCounter('billing_quota_sync_failed_total', { leg });
  }

  // Persist a durable "sync dirty" signal so the lifecycle reconciler
  // (subscription-lifecycle.reconcileFailedEntitlementSyncs) can re-drive a
  // sync that failed-open during a transient quota/platform outage. Set the
  // marker on failure, clear it on a clean sync — a surgical dot-path update so
  // a concurrent metadata write (grace/renewal markers) isn't clobbered. Keyed
  // by subscriptionId; best-effort + swallowed so it can NOT alter the
  // fail-open contract (this function still returns `ok` and never throws).
  if (subscriptionId) {
    try {
      await Subscription.updateOne(
        { _id: subscriptionId },
        ok
          ? { $unset: { 'metadata.entitlementSyncPending': '' } }
          : { $set: { 'metadata.entitlementSyncPending': true } },
      );
    } catch (err) {
      logger.warn('Failed to persist entitlementSyncPending marker', {
        orgId, subscriptionId, error: errorMessage(err),
      });
    }
  }

  return ok;
}

/**
 * Build a full subscription response object (used in GET, POST, PUT routes).
 */
export function buildSubscriptionResponse(
  subscription: {
    _id: { toString(): string };
    orgId: string;
    planId: string;
    status: string;
    interval: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    addons?: Array<{ bundleId: string; quantity: number }>;
    createdAt: Date;
    updatedAt: Date;
  },
  planName?: string,
  tier?: string,
): Record<string, unknown> {
  return {
    id: subscription._id.toString(),
    orgId: subscription.orgId,
    planId: subscription.planId,
    ...(planName !== undefined && { planName }),
    ...(tier !== undefined && { tier }),
    status: subscription.status,
    interval: subscription.interval,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    // Purchased add-on bundles — the billing UI reads these on load.
    addons: (subscription.addons ?? []).map((a) => ({ bundleId: a.bundleId, quantity: a.quantity })),
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}
