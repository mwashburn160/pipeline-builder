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
// Single source of truth lives in the leaf module (prevents drift across
// billing-helpers / discount-helpers / promotion-engine); re-exported here so
// existing importers of billing-helpers are unaffected.
export { MANAGEABLE_SUBSCRIPTION_STATUSES } from './subscription-status.js';

/** Resolve the per-request timeout for billing's outbound service calls. */
export function getBillingTimeout(): number {
  const server = Config.get('server') as { services?: { billingTimeout?: number } } | undefined;
  return server?.services?.billingTimeout ?? 5000;
}

/**
 * Mint the service-to-service auth header billing uses on its NO-USER (system)
 * paths — webhook / lifecycle cron / marketplace SNS / admin — for the
 * quota/platform fan-out. Centralizes the `serviceName: 'billing'` / `role:
 * 'owner'` literals that were repeated ~10× inline so a single typo can't grant
 * the wrong role or misname the service. Scoped to the target `orgId` so the
 * downstream service sees a real tenant identity (keeps RLS / audit attributable
 * to the org being mutated). Callers that thread a REAL bearer keep their
 * `authHeader || billingServiceAuth(orgId)` fallback — this replaces only the
 * fallback literal, never a user credential.
 */
export function billingServiceAuth(orgId: string, role: 'owner' | 'member' = 'owner'): string {
  return getServiceAuthHeader({ serviceName: 'billing', orgId, role });
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
 * Shared entitlement-sync leg: PUT the effective entitlement to a downstream
 * service and, on any failure, write a `*_sync_failed` `subscription_updated`
 * audit row so support can see the local billing state drifted. Every sync
 * target (quota / platform seats / reporting retention / compliance sets) shares
 * this exact handshake — createSafeClient with the billing timeout, the
 * `authHeader || billingServiceAuth(orgId)` service-token fallback (system paths
 * pass `''`), and the `{ Authorization, 'x-org-id': orgId }` headers — so they
 * live here once instead of four near-identical copies. `logFields` are folded
 * into both the log lines and the audit-row details. Best-effort; never throws.
 */
async function pushEntitlementLeg(opts: {
  orgId: string;
  service: { host: string; port: number };
  path: string;
  body: Record<string, unknown>;
  authHeader: string;
  failReason: string;
  logLabel: string;
  logFields: Record<string, unknown>;
  subscriptionId?: string;
}): Promise<boolean> {
  const { orgId, service, path, body, authHeader, failReason, logLabel, logFields, subscriptionId } = opts;
  try {
    const client = createSafeClient({ host: service.host, port: service.port, timeout: getBillingTimeout() });
    const effectiveAuth = authHeader || billingServiceAuth(orgId);
    const response = await client.put(path, body, {
      headers: { 'Authorization': effectiveAuth, 'x-org-id': orgId },
    });
    if (response && response.statusCode < 400) {
      logger.info(`Synced ${logLabel}`, { orgId, ...logFields });
      return true;
    }
    logger.error(`Failed to sync ${logLabel}`, { orgId, ...logFields, statusCode: response?.statusCode });
    await createBillingEvent(orgId, 'subscription_updated', { reason: failReason, ...logFields, statusCode: response?.statusCode }, subscriptionId);
    return false;
  } catch (error) {
    logger.error(`Error syncing ${logLabel}`, { orgId, ...logFields, error });
    await createBillingEvent(orgId, 'subscription_updated', { reason: failReason, ...logFields, error: error instanceof Error ? error.message : String(error) }, subscriptionId);
    return false;
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
  // Push EXPLICIT effective limits (tier + bundles) so a plain tier reseed can't
  // wipe purchased add-ons. The service token (minted per target org by the leg)
  // gives the quota service a real tenant identity for RLS/audit attribution.
  return pushEntitlementLeg({
    orgId,
    service: config.quotaService,
    path: `/quotas/${orgId}`,
    body: quotas ? { tier, quotas } : { tier },
    authHeader,
    failReason: 'quota_sync_failed',
    logLabel: 'tier to quota service',
    logFields: { tier },
    subscriptionId,
  });
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
  // Push the account `tier` alongside seats/features so a plan DOWNGRADE
  // invalidates stale JWTs platform-side (the token re-derives tier-included
  // features from `org.tier`). Platform sets ONLY the tier label here — it never
  // reseeds quotas (billing owns limits, synced to the quota service). The audit
  // row records `seats` only (matching the prior behavior), so keep logFields tight.
  return pushEntitlementLeg({
    orgId,
    service: config.platformService,
    path: `/organization/${orgId}/seat-limit`,
    body: { seats, features, tier },
    authHeader,
    failReason: 'seat_sync_failed',
    logLabel: 'seat limit to platform',
    logFields: { seats },
    subscriptionId,
  });
}

/** Absolute retention ceiling (days) — mirrors reporting's RETENTION_MAX_DAYS. */
const RETENTION_MAX_DAYS = 730;

/** Clamp an effective retention to the 730-day ceiling; `-1` (unlimited) passes
 *  through untouched. Defensive: bundle `maxQuantity` already bounds purchases,
 *  but the sync leg clamps too so a mis-configured baseline can never push
 *  reporting past its own ceiling. */
function clampRetentionDays(v: number): number {
  return v === -1 ? -1 : Math.min(v, RETENTION_MAX_DAYS);
}

/**
 * Push the effective RETENTION entitlement to the reporting service. Retention
 * is NOT a quota-service type (it's absent from `VALID_QUOTA_TYPES`) — it rides
 * `QuotaTierLimits` only to reuse the tier-baseline + bundle-grant math, then
 * syncs to reporting's `dora_settings`. `eventRetentionDays`/`doraRetentionDays`
 * are the EFFECTIVE values (tier base + bundles; `-1` = unlimited). Mirrors
 * `pushSeatLimitToPlatform` EXACTLY: same createSafeClient handshake, the same
 * `authHeader || billingServiceAuth(orgId)` service-token fallback, and the same
 * `{ Authorization, 'x-org-id': orgId }` headers so reporting authorizes the
 * billing service token identically to platform's seat-limit route. Best-effort
 * with an audit row on failure; reporting resolves the org to its root.
 */
async function pushRetentionToReporting(
  orgId: string,
  limits: { eventRetentionDays: number; doraRetentionDays: number },
  authHeader: string,
  subscriptionId?: string,
): Promise<boolean> {
  const eventRetentionDays = clampRetentionDays(limits.eventRetentionDays);
  const doraRetentionDays = clampRetentionDays(limits.doraRetentionDays);
  return pushEntitlementLeg({
    orgId,
    service: config.reportingService,
    path: `/api/reports/retention-sync/${orgId}`,
    body: { eventRetentionDays, doraRetentionDays },
    authHeader,
    failReason: 'retention_sync_failed',
    logLabel: 'retention to reporting',
    logFields: { eventRetentionDays, doraRetentionDays },
    subscriptionId,
  });
}

/**
 * Derive the compliance CONTENT SETS an account is entitled to from its EFFECTIVE
 * feature flags (tier-included + bundle-granted). `compliance_standard`→'standard',
 * `compliance_advanced`→'advanced'. Enterprise / Unlimited include both flags via
 * `TIER_FEATURES`, so they resolve to `['standard','advanced']`. Order is stable
 * (standard before advanced). Pure.
 */
export function deriveComplianceSets(features: readonly string[]): string[] {
  const sets: string[] = [];
  if (features.includes('compliance_standard')) sets.push('standard');
  if (features.includes('compliance_advanced')) sets.push('advanced');
  return sets;
}

/**
 * The EFFECTIVE feature set (tier baseline ∪ bundle grants) for a tier + add-ons
 * combination. `effectiveEntitlements` only returns the bundle-granted flags, so
 * this folds in `TIER_FEATURES[tier]` — the SAME union `syncEntitlements` computes
 * before pushing compliance sets. Enterprise / Unlimited include both compliance
 * flags via the tier baseline (they carry no compliance bundle), which is exactly
 * why the drift reconciler must derive sets from THIS set, not the bundle grants
 * alone. Pure.
 */
export function effectiveFeatureSet(
  tier: QuotaTier,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }> = [],
): string[] {
  const { features } = effectiveEntitlements(tier, addons, getBundleCatalog());
  return [...new Set<string>([...(TIER_FEATURES[tier] ?? []), ...features])];
}

/**
 * Push the effective COMPLIANCE CONTENT-SET entitlement to the compliance service.
 * The curated compliance rule libraries (standard / advanced) are content sets,
 * NOT a quota-service type — the org holds subscription pointers that the
 * compliance service auto-subscribes/activates (for entitled sets) or deactivates
 * (for lost sets) to match `sets`. `features` is the EFFECTIVE feature set (tier +
 * bundles); the entitled sets are derived via {@link deriveComplianceSets}. Mirrors
 * `pushRetentionToReporting` EXACTLY: same createSafeClient handshake, the same
 * `authHeader || billingServiceAuth(orgId)` service-token fallback, and the same
 * `{ Authorization, 'x-org-id': orgId }` headers so the compliance service
 * authorizes the billing service token identically to reporting's retention-sync /
 * platform's seat-limit route. Best-effort with an audit row on failure; the
 * compliance service resolves the org to its root and reconciles idempotently.
 */
export async function pushComplianceSetsToCompliance(
  orgId: string,
  features: readonly string[],
  authHeader: string,
  subscriptionId?: string,
  // ISO string of the entitlement-change moment (handshake #1). The compliance
  // service keeps a per-org watermark and IGNORES a push whose `occurredAt` is
  // older than the last applied one, so two syncs racing for the same org can't
  // apply out of order. Defaults to now — the change is happening at call time.
  occurredAt: string = new Date().toISOString(),
): Promise<boolean> {
  const sets = deriveComplianceSets(features);
  return pushEntitlementLeg({
    orgId,
    service: config.complianceService,
    path: `/api/compliance/entitlements/${orgId}`,
    body: { sets, occurredAt },
    authHeader,
    failReason: 'compliance_sync_failed',
    logLabel: 'compliance sets to compliance service',
    logFields: { sets },
    subscriptionId,
  });
}

/** The active add-on bundle catalog (env-driven, from pipeline-core config). */
export function getBundleCatalog(): readonly BundleConfig[] {
  return (Config.get('billing') as BillingConfig | undefined)?.bundles ?? [];
}

/** Whether purchasable add-on bundles are enabled (`BILLING_BUNDLES_ENABLED`).
 *  Default ON (opt-out) across all environments — mirrors `BILLING_ENABLED`'s
 *  style; set `'false'` to hide the add-on catalog. Self-service is still gated
 *  separately for AWS Marketplace (see `bundleSelfServiceAllowed`). */
export function bundlesEnabled(): boolean {
  return (process.env.BILLING_BUNDLES_ENABLED || 'true').toLowerCase() !== 'false';
}

// Combo-discount pricing (getComboDiscounts / activeComboCredits / packing) lives
// in ./combo-pricing.js — isolated so the packing logic can grow independently and
// so suites that mock billing-helpers don't need to stub it.

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
    // Meter every provider add-on sync failure so SRE can alert (mirrors
    // billing_quota_sync_failed_total / billing_event_write_failed_total) — covers
    // BOTH the user add/remove path and the auto-prune finalizer via `source`.
    incCounter('billing_provider_addon_sync_failed_total', { source });
    // Durable marker so the lifecycle reconciler re-drives the removal from the
    // CURRENT reduced add-on list — otherwise a transient Stripe failure during a
    // tier upgrade leaves the customer billed for the pruned bundle forever
    // (invisibly), unlike the entitlement leg's entitlementSyncPending recovery.
    await setProviderAddonSyncPending(subscriptionId, orgId, true);
  }
}

/**
 * Set/clear the durable `metadata.providerAddonSyncPending` marker on a
 * Subscription — the provider-leg twin of `entitlementSyncPending`. When
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
  const auth = authHeader || billingServiceAuth(orgId);
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
 * FOUR-TARGET fan-out (docs/billing-bundles.md §5): the 9 tracked quota limits
 * go to the quota service; SEATS go to platform (quota has no `seats`); RETENTION
 * (event/dora days) goes to reporting (retention isn't a quota type — it rides
 * `QuotaTierLimits` only to reuse the base+bundle math); COMPLIANCE content sets
 * (standard/advanced, derived from the effective feature flags) go to the
 * compliance service. All four target the subscription's org (root-scoped).
 * Returns true only if all legs succeed.
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
  // go to platform (platform owns both); retention days go to reporting.
  const tracked: Record<string, number> = {};
  for (const t of VALID_QUOTA_TYPES) tracked[t] = limits[t];

  // Compliance content sets are derived from the EFFECTIVE feature set — the union
  // of tier-included features (`TIER_FEATURES[tier]`; Enterprise/Unlimited auto-
  // include both compliance flags) and the bundle-granted features. Shared with the
  // drift reconciler via {@link effectiveFeatureSet} so the two can't diverge.
  const effectiveFeatures = effectiveFeatureSet(tier, addons);

  const [quotaOk, seatOk, retentionOk, complianceOk] = await Promise.all([
    syncTierToQuotaService(orgId, tier, authHeader, subscriptionId, tracked),
    pushSeatLimitToPlatform(orgId, limits.seats, features, authHeader, subscriptionId, tier),
    pushRetentionToReporting(
      orgId,
      { eventRetentionDays: limits.eventRetentionDays, doraRetentionDays: limits.doraRetentionDays },
      authHeader,
      subscriptionId,
    ),
    pushComplianceSetsToCompliance(orgId, effectiveFeatures, authHeader, subscriptionId),
  ]);

  const ok = quotaOk && seatOk && retentionOk && complianceOk;
  if (!ok) {
    // Every caller currently fires-and-forgets this result — the user's
    // subscription mutation succeeds regardless (by design). Centralise the
    // failure observability here so a swallowed return can't hide entitlement
    // drift: log at error level AND emit a distinct, aggregatable metric so SRE
    // can alert + reconcile. The failing leg(s) also wrote a `billing_events`
    // audit row (reason quota_sync_failed / seat_sync_failed) inside
    // syncTierToQuotaService / pushSeatLimitToPlatform / pushRetentionToReporting,
    // so the drift is both metered and auditable without failing the request.
    const leg = [
      !quotaOk ? 'quota' : null,
      !seatOk ? 'seat' : null,
      !retentionOk ? 'reporting' : null,
      !complianceOk ? 'compliance' : null,
    ].filter(Boolean).join('+');
    logger.error('Entitlement sync incomplete — local billing state may have drifted from quota/platform/reporting/compliance', {
      orgId, tier, subscriptionId, quotaOk, seatOk, retentionOk, complianceOk, leg,
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
    recurringDiscount?: { discountId: string; unit: string; value: number } | null;
    creditBalanceCents?: number;
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
    // Applied discounts (usage-credit model): the standing recurring rule (if any)
    // and the remaining usage-credit balance the UI renders on the billing page.
    recurringDiscount: subscription.recurringDiscount
      ? { discountId: subscription.recurringDiscount.discountId, unit: subscription.recurringDiscount.unit, value: subscription.recurringDiscount.value }
      : null,
    creditRemainingCents: subscription.creditBalanceCents ?? 0,
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}
