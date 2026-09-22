// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Entitlement sync: push an account's EFFECTIVE entitlements (tier baseline +
 * add-on bundles) to every downstream store that enforces them — quota limits,
 * platform seats/features, reporting retention, compliance content sets — with
 * durable-bus retry on failure, plus the over-cap guard that refuses an add-on
 * change which would drop a count quota below current usage.
 */

import type { QuotaTier, DurableEventBus, EventSubscription } from '@pipeline-builder/api-core';
import { clampRetentionDays, complianceSetsForFeatures, createLogger, errorMessage, TIER_FEATURES, VALID_QUOTA_TYPES } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { effectiveEntitlements } from '../config/entitlements.js';
import { config } from '../config.js';
import { billingServiceAuth, createBillingEvent, getBundleCatalog } from './billing-helpers.js';
import { fetchQuotaTypeUsage, fetchSeatUsage, putJson, type ServiceTarget } from './downstream-client.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES, isGraceDowngraded } from './subscription-status.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import type { SubscriptionDocument } from '../models/subscription.js';

const logger = createLogger('entitlement-sync');

/**
 * Shared entitlement-sync leg: PUT the effective entitlement to a downstream
 * service and, on any failure, write a `*_sync_failed` `subscription_updated`
 * audit row so support can see the local billing state drifted. Every sync
 * target (quota / platform seats / reporting retention / compliance sets) shares
 * this exact handshake — the downstream client's tenant PUT and the
 * `authHeader || billingServiceAuth(orgId)` service-token fallback (system paths
 * pass `''`) — so they live here once. `logFields` are folded
 * into both the log lines and the audit-row details. Best-effort; never throws.
 */
async function pushEntitlementLeg(opts: {
  orgId: string;
  service: ServiceTarget;
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
    // Inside the try so a config-access / token-mint error stays in the fail-open path.
    const response = await putJson(service, path, body, orgId, authHeader || billingServiceAuth(orgId));
    if (response && response.statusCode < 400) {
      logger.info(`Synced ${logLabel}`, { orgId, ...logFields });
      return true;
    }
    logger.error(`Failed to sync ${logLabel}`, { orgId, ...logFields, statusCode: response?.statusCode });
    await createBillingEvent(orgId, 'subscription_updated', { reason: failReason, ...logFields, statusCode: response?.statusCode }, subscriptionId);
    return false;
  } catch (error) {
    logger.error(`Error syncing ${logLabel}`, { orgId, ...logFields, error });
    await createBillingEvent(orgId, 'subscription_updated', { reason: failReason, ...logFields, error: errorMessage(error) }, subscriptionId);
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
  /** ISO moment of the entitlement change (see EntitlementSyncEvent.occurredAt). */
  occurredAt: string = new Date().toISOString(),
): Promise<boolean> {
  // Push EXPLICIT effective limits (tier + bundles) so a plain tier reseed can't
  // wipe purchased add-ons. The service token (minted per target org by the leg)
  // gives the quota service a real tenant identity for RLS/audit attribution.
  return pushEntitlementLeg({
    orgId,
    service: config.quotaService,
    path: `/quotas/${orgId}`,
    body: quotas ? { tier, quotas, occurredAt } : { tier, occurredAt },
    authHeader,
    failReason: 'quota_sync_failed',
    logLabel: 'tier to quota service',
    logFields: { tier },
    subscriptionId,
  });
}

/**
 * Push the effective SEAT limit to the platform service. Seats are platform-
 * owned (not a quota-service type — see docs/org-team-hierarchy.md), so
 * they can't ride the quota sync. `seats` is the EFFECTIVE limit (tier +
 * bundles). Best-effort with an audit row on failure; platform resolves the org
 * to its root.
 */
async function pushSeatLimitToPlatform(
  orgId: string,
  seats: number,
  features: string[],
  authHeader: string,
  subscriptionId: string | undefined,
  tier: QuotaTier,
  occurredAt: string,
): Promise<boolean> {
  // Push the account `tier` alongside seats/features so a plan DOWNGRADE
  // invalidates stale JWTs platform-side (the token re-derives tier-included
  // features from `org.tier`). Platform sets ONLY the tier label here — it never
  // reseeds quotas (billing owns limits, synced to the quota service). The audit
  // row records `seats` only, so keep logFields tight.
  return pushEntitlementLeg({
    orgId,
    service: config.platformService,
    path: `/organization/${orgId}/seat-limit`,
    body: { seats, features, tier, occurredAt },
    authHeader,
    failReason: 'seat_sync_failed',
    logLabel: 'seat limit to platform',
    logFields: { seats },
    subscriptionId,
  });
}

/**
 * Push the effective RETENTION entitlement to the reporting service. Retention
 * is NOT a quota-service type (it's absent from `VALID_QUOTA_TYPES`) — it rides
 * `QuotaTierLimits` only to reuse the tier-baseline + bundle-grant math, then
 * syncs to reporting's `dora_settings`. `eventRetentionDays`/`doraRetentionDays`
 * are the EFFECTIVE values (tier base + bundles; `-1` = unlimited). Rides the
 * shared entitlement leg, so reporting authorizes the billing service token
 * identically to platform's seat-limit route. Best-effort with an audit row on
 * failure; reporting resolves the org to its root.
 */
async function pushRetentionToReporting(
  orgId: string,
  limits: { eventRetentionDays: number; doraRetentionDays: number },
  authHeader: string,
  subscriptionId: string | undefined,
  occurredAt: string,
): Promise<boolean> {
  const eventRetentionDays = clampRetentionDays(limits.eventRetentionDays);
  const doraRetentionDays = clampRetentionDays(limits.doraRetentionDays);
  return pushEntitlementLeg({
    orgId,
    service: config.reportingService,
    path: `/reports/retention-sync/${orgId}`,
    body: { eventRetentionDays, doraRetentionDays, occurredAt },
    authHeader,
    failReason: 'retention_sync_failed',
    logLabel: 'retention to reporting',
    logFields: { eventRetentionDays, doraRetentionDays },
    subscriptionId,
  });
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
 * bundles); the entitled sets are derived via api-core's `complianceSetsForFeatures`. Rides
 * the shared entitlement leg, so the compliance service authorizes the billing
 * service token identically to reporting's retention-sync / platform's seat-limit
 * route. Best-effort with an audit row on failure; the compliance service
 * resolves the org to its root and reconciles idempotently.
 */
export async function pushComplianceSetsToCompliance(
  orgId: string,
  features: readonly string[],
  authHeader: string,
  subscriptionId?: string,
  // ISO string of the entitlement-change moment. The compliance
  // service keeps a per-org watermark and IGNORES a push whose `occurredAt` is
  // older than the last applied one, so two syncs racing for the same org can't
  // apply out of order. Defaults to now — the change is happening at call time.
  occurredAt: string = new Date().toISOString(),
): Promise<boolean> {
  const sets = complianceSetsForFeatures(features);
  return pushEntitlementLeg({
    orgId,
    service: config.complianceService,
    path: `/compliance/entitlements/${orgId}`,
    body: { sets, occurredAt },
    authHeader,
    failReason: 'compliance_sync_failed',
    logLabel: 'compliance sets to compliance service',
    logFields: { sets },
    subscriptionId,
  });
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
 * pooled usage (docs/billing-bundles.md). Guards seats (platform),
 * plugins/pipelines/listings (quota) — these can't auto-shrink (`listings` is
 * raised by the `listing_pack` add-on, so removing packs below the org's active
 * listing count is refused). Rate-based quotas
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
    // downstream client so this guard can't drift from the other seat readers.
    const seatSnapshot = await fetchSeatUsage(orgId, auth);
    const used = seatSnapshot?.used ?? null;
    if (used !== null && used > limits.seats) {
      overages.push({ quotaType: 'seats', currentUsage: used, targetCap: limits.seats, overage: used - limits.seats });
    }
  }
  for (const field of ['plugins', 'pipelines', 'listings'] as const) {
    if (limits[field] === -1) continue;
    const used = await fetchQuotaTypeUsage(orgId, field, auth);
    if (used !== null && used > limits[field]) {
      overages.push({ quotaType: field, currentUsage: used, targetCap: limits[field], overage: used - limits[field] });
    }
  }
  return overages;
}

/**
 * Durable event backbone for entitlement-sync RETRY. When a sync leg fails, we
 * publish a retry event to the bus, which redelivers at-least-once (consumer
 * group + XAUTOCLAIM) until the sync succeeds. Set at startup via
 * {@link setEntitlementSyncBus}; `null` when Redis isn't configured, in which case
 * a failed sync has no durable retry (still logged + audited + metered), matching
 * every other fail-safe-degrades-without-Redis path in the service.
 */
const ENTITLEMENT_SYNC_TOPIC = 'entitlement.sync';
let entitlementSyncBus: DurableEventBus | null = null;

interface EntitlementSyncEvent {
  orgId: string;
  tier: QuotaTier;
  subscriptionId?: string;
  addons: Array<{ bundleId: string; quantity: number }>;
  /** When the entitlement change happened (ISO). A redelivered retry carries the
   *  ORIGINAL moment, so compliance's watermark ignores it if a newer sync has
   *  already been applied — a stale retry can't roll an org back. */
  occurredAt: string;
}

/** Register (or clear) the durable bus used for entitlement-sync retries. */
export function setEntitlementSyncBus(bus: DurableEventBus | null): void {
  entitlementSyncBus = bus;
}

/**
 * Start the billing-side consumer that re-drives failed entitlement syncs off the
 * durable bus. The handler THROWS on an incomplete sync so the bus leaves the
 * message pending and redelivers it (at-least-once) until every leg succeeds.
 * Idempotent syncs make redelivery safe. Call once at startup.
 */
export function startEntitlementSyncConsumer(bus: DurableEventBus): EventSubscription {
  return bus.subscribe<EntitlementSyncEvent>({
    topic: ENTITLEMENT_SYNC_TOPIC,
    group: 'billing-entitlement-sync',
    consumer: `billing-${process.pid}`,
    handler: async (env) => {
      const { orgId, subscriptionId } = env.payload;
      let { tier, occurredAt } = env.payload;
      let addons: ReadonlyArray<{ bundleId: string; quantity: number }> = env.payload.addons ?? [];
      // A retry can sit on the bus for minutes; the subscription may have changed
      // plan, bought/dropped an add-on, lapsed or been canceled since. Replaying the
      // PAYLOAD would re-push that stale state over the newer one (a canceled org
      // re-granted its paid tier). Re-read the row and push what it warrants NOW,
      // stamped with the row's own change time.
      if (subscriptionId) {
        const current = await Subscription.findById(subscriptionId);
        if (!current) {
          logger.warn('Entitlement-sync retry dropped — subscription no longer exists', { orgId, subscriptionId });
          incCounter('billing_entitlement_sync_retry_dropped_total', { reason: 'subscription_missing' });
          return;
        }
        const entitlement = await currentSubscriptionEntitlement(current);
        if (!entitlement) {
          // Not retriable: the plan row is gone. Surface it, don't loop on it.
          logger.error('Entitlement-sync retry dropped — subscription plan not found', { orgId, subscriptionId, planId: current.planId });
          incCounter('billing_entitlement_sync_retry_dropped_total', { reason: 'plan_missing' });
          return;
        }
        ({ tier, addons } = entitlement);
        occurredAt = subscriptionOccurredAt(current);
      }
      // Fresh service token (the producing request's bearer is long gone).
      const ok = await applyEntitlements(orgId, tier, billingServiceAuth(orgId), subscriptionId, addons, occurredAt);
      if (!ok) throw new Error(`entitlement sync redelivery incomplete for org ${orgId}`);
    },
  });
}

/**
 * The entitlement a subscription row CURRENTLY warrants: its plan tier + add-ons
 * while it is manageable and not grace-downgraded, else the un-subscribed
 * `developer` baseline with no add-ons (canceled / incomplete / lapsed past_due).
 * `null` when an entitled row's plan can't be found (dangling planId). Shared by
 * the retry consumer and the drift reconciler so both derive "expected" the same way.
 */
export async function currentSubscriptionEntitlement(
  subscription: Pick<SubscriptionDocument, 'status' | 'planId' | 'addons' | 'metadata'>,
): Promise<{ tier: QuotaTier; addons: Array<{ bundleId: string; quantity: number }> } | null> {
  const entitled = (MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)
    && !isGraceDowngraded(subscription);
  if (!entitled) return { tier: 'developer', addons: [] };
  const plan = await Plan.findById(subscription.planId);
  if (!plan) return null;
  return { tier: plan.tier, addons: [...(subscription.addons ?? [])] };
}

/** A subscription row's change moment (ISO) — the `occurredAt` every leg carries. */
function subscriptionOccurredAt(subscription: { updatedAt?: Date | null }): string {
  const at = subscription.updatedAt;
  return at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : new Date().toISOString();
}

/**
 * Sync an account's EFFECTIVE entitlements (tier + add-on bundles) with a
 * FOUR-TARGET fan-out (docs/billing-bundles.md): the tracked quota limits
 * (`VALID_QUOTA_TYPES`) go to the quota service; SEATS go to platform (quota has no `seats`); RETENTION
 * (event/dora days) goes to reporting (retention isn't a quota type — it rides
 * `QuotaTierLimits` only to reuse the base+bundle math); COMPLIANCE content sets
 * (standard/advanced, derived from the effective feature flags) go to the
 * compliance service. All four target the subscription's org (root-scoped).
 * Returns true only if all legs succeed.
 *
 * The bus-publish-on-failure lives in the {@link syncEntitlements} wrapper, NOT
 * here, so the consumer can re-drive this body without re-publishing (which would
 * loop) — it relies on bus redelivery instead.
 */
async function applyEntitlements(
  orgId: string,
  tier: QuotaTier,
  authHeader: string,
  subscriptionId?: string,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }> = [],
  /** ISO moment of the entitlement change; see {@link EntitlementSyncEvent.occurredAt}. */
  occurredAt: string = new Date().toISOString(),
): Promise<boolean> {
  const { limits, features } = effectiveEntitlements(tier, addons, getBundleCatalog());
  // Every tracked type (VALID_QUOTA_TYPES, incl. `listings` raised by
  // `listing_pack`) goes to quota; `seats` + purchased feature entitlements
  // go to platform (platform owns both); retention days go to reporting.
  const tracked: Record<string, number> = {};
  for (const t of VALID_QUOTA_TYPES) tracked[t] = limits[t];

  // Compliance content sets are derived from the EFFECTIVE feature set — the union
  // of tier-included features (`TIER_FEATURES[tier]`; Enterprise/Unlimited auto-
  // include both compliance flags) and the bundle-granted features. Shared with the
  // drift reconciler via {@link effectiveFeatureSet} so the two can't diverge.
  const effectiveFeatures = effectiveFeatureSet(tier, addons);

  // Every leg carries the same change moment so a receiver that keeps a
  // watermark (compliance today) can refuse an out-of-order push.
  const [quotaOk, seatOk, retentionOk, complianceOk] = await Promise.all([
    syncTierToQuotaService(orgId, tier, authHeader, subscriptionId, tracked, occurredAt),
    pushSeatLimitToPlatform(orgId, limits.seats, features, authHeader, subscriptionId, tier, occurredAt),
    pushRetentionToReporting(
      orgId,
      { eventRetentionDays: limits.eventRetentionDays, doraRetentionDays: limits.doraRetentionDays },
      authHeader,
      subscriptionId,
      occurredAt,
    ),
    pushComplianceSetsToCompliance(orgId, effectiveFeatures, authHeader, subscriptionId, occurredAt),
  ]);

  const ok = quotaOk && seatOk && retentionOk && complianceOk;
  if (!ok) {
    // Every caller fires-and-forgets this result — the user's subscription
    // mutation succeeds regardless (by design). Centralise the failure
    // observability here so a swallowed return can't hide entitlement drift: log
    // at error level AND emit a distinct, aggregatable metric so SRE can alert +
    // reconcile. Each failing leg also wrote its own `billing_events` audit row
    // (reason quota_sync_failed / seat_sync_failed / retention_sync_failed /
    // compliance_sync_failed) via the shared entitlement leg, so the drift is both
    // metered and auditable without failing the request.
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

  return ok;
}

/**
 * Sync entitlements on the request/webhook path, with DURABLE retry on failure.
 *
 * Runs the four-leg fan-out inline (so the happy path is synchronous and the
 * caller's mutation reflects the attempt), and if any leg fails, publishes a
 * retry event to the durable bus — the consumer ({@link startEntitlementSyncConsumer})
 * then re-drives it at-least-once until it succeeds. Best-effort + never throws
 * (preserves the fail-open contract);
 * when no bus is wired the failure is still logged/audited/metered, just without
 * durable retry.
 */
export async function syncEntitlements(
  orgId: string,
  tier: QuotaTier,
  authHeader: string,
  subscriptionId?: string,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }> = [],
): Promise<boolean> {
  // The change moment is the subscription row's own `updatedAt` (every caller
  // syncs right after saving it), so an inline push and any later retry carry the
  // SAME timestamp as the state they describe. No row (or an unreadable one) ⇒ now.
  let occurredAt = new Date().toISOString();
  if (subscriptionId) {
    try {
      const row = await Subscription.findById(subscriptionId).select('updatedAt').lean();
      if (row) occurredAt = subscriptionOccurredAt(row as { updatedAt?: Date });
    } catch (err) {
      logger.warn('Could not read subscription updatedAt for occurredAt; using now', { orgId, subscriptionId, error: errorMessage(err) });
    }
  }
  const ok = await applyEntitlements(orgId, tier, authHeader, subscriptionId, addons, occurredAt);
  if (!ok && entitlementSyncBus) {
    // Fire the durable retry. The real bus.publish is fail-safe (drops-with-metric,
    // never throws), but guard anyway so NO bus implementation can break the
    // fail-open contract (syncEntitlements must never throw).
    try {
      await entitlementSyncBus.publish<EntitlementSyncEvent>(ENTITLEMENT_SYNC_TOPIC, {
        orgId, tier, subscriptionId, addons: [...addons], occurredAt,
      });
    } catch (err) {
      logger.warn('Failed to publish entitlement-sync retry event', { orgId, subscriptionId, error: errorMessage(err) });
    }
  }
  return ok;
}
