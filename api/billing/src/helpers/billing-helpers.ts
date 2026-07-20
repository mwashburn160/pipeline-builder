// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaTier } from '@pipeline-builder/api-core';
import { createLogger, createSafeClient, errorMessage, getServiceAuthHeader, VALID_QUOTA_TYPES } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config, effectiveEntitlements, type BillingConfig, type BundleConfig } from '@pipeline-builder/pipeline-core';
import { config } from '../config.js';
import { BillingEvent } from '../models/billing-event.js';
import type { BillingEventType } from '../models/billing-event.js';
import { Subscription } from '../models/subscription.js';
import type { BillingInterval } from '../models/subscription.js';

const logger = createLogger('billing-helpers');

// Re-export so callers can keep importing from billing-helpers, but the
// canonical declaration lives with the Mongoose model.
export type { BillingInterval };

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
 */
export async function createBillingEvent(
  orgId: string,
  type: BillingEventType,
  details: Record<string, unknown> = {},
  subscriptionId?: string,
): Promise<void> {
  try {
    await BillingEvent.create({ orgId, type, details, subscriptionId });
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
): Promise<boolean> {
  try {
    const client = createSafeClient({
      host: config.platformService.host,
      port: config.platformService.port,
      timeout: getBillingTimeout(),
    });
    const effectiveAuth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });
    const response = await client.put(`/organization/${orgId}/seat-limit`, { seats, features }, {
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

/** A count-quota that would be over its (reduced) cap after an add-on change. */
export interface Overage {
  quotaType: string;
  currentUsage: number;
  targetCap: number;
  overage: number;
}

/** Read current pooled seat usage from platform; null on any error (fail-open). */
async function readSeatUsage(orgId: string, authHeader: string): Promise<number | null> {
  try {
    const client = createSafeClient({ host: config.platformService.host, port: config.platformService.port, timeout: getBillingTimeout() });
    const resp = await client.get<{ used?: number }>(`/organization/${orgId}/seat-usage`, { headers: { 'Authorization': authHeader, 'x-org-id': orgId } });
    if (resp && resp.statusCode < 400) return resp.body?.used ?? null;
  } catch { /* fall through */ }
  return null;
}

/** Read current pooled usage for a tracked quota type; null on error (fail-open). */
async function readQuotaUsage(orgId: string, quotaType: string, authHeader: string): Promise<number | null> {
  try {
    const client = createSafeClient({ host: config.quotaService.host, port: config.quotaService.port, timeout: getBillingTimeout() });
    const resp = await client.get<{ data?: { status?: { used?: number } } }>(`/quotas/${orgId}/${quotaType}`, { headers: { 'Authorization': authHeader, 'x-org-id': orgId } });
    if (resp && resp.statusCode < 400) return resp.body?.data?.status?.used ?? null;
  } catch { /* fall through */ }
  return null;
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
    const used = await readSeatUsage(orgId, auth);
    if (used !== null && used > limits.seats) {
      overages.push({ quotaType: 'seats', currentUsage: used, targetCap: limits.seats, overage: used - limits.seats });
    }
  }
  for (const field of ['plugins', 'pipelines'] as const) {
    if (limits[field] === -1) continue;
    const used = await readQuotaUsage(orgId, field, auth);
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
    pushSeatLimitToPlatform(orgId, limits.seats, features, authHeader, subscriptionId),
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
