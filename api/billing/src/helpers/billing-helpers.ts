// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Core billing helpers shared by every flow: the outbound-call timeout, the
 * system service token, period math, the `billing_events` writer, and the
 * add-on catalog switches. The entitlement fan-out lives in
 * `entitlement-sync.ts`, the add-on prune / provider line-item leg in
 * `addon-prune.ts`, and the route response shape in `subscription-response.ts`.
 */

import { createLogger, envBool, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { getBillingConfig } from '../config/billing-config.js';
import type { BundleConfig } from '../config/billing-types.js';
import { config } from '../config.js';
import { BillingEvent } from '../models/billing-event.js';
import type { BillingEventType } from '../models/billing-event.js';
import type { BillingInterval } from '../models/subscription.js';

const logger = createLogger('billing-helpers');

/** Resolve the per-request timeout for billing's outbound service calls. */
export function getBillingTimeout(): number {
  const server = Config.get('server') as { services?: { billingTimeout?: number } } | undefined;
  return server?.services?.billingTimeout ?? 5000;
}

/**
 * Mint the service-to-service auth header billing uses on its NO-USER (system)
 * paths — webhook / lifecycle cron / marketplace SNS / admin — for the
 * quota/platform fan-out. Centralizes the `serviceName: 'billing'` / `role:
 * 'owner'` literals so a single typo can't grant the wrong role or misname the
 * service. Scoped to the target `orgId` so the
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
 * Record the "reactivated INTO an entitled status but the subscription's planId
 * points at a missing/deleted plan, so no tier could be re-granted" signal —
 * a `subscription_updated` audit row (`reason: 'reactivate_plan_missing'`) plus
 * the `billing_reactivate_plan_missing_total` metric. Shared by the three
 * reactivation paths (stripe webhook / admin / marketplace) so the event reason
 * string and metric name can't drift between them; each caller keeps its own
 * contextual WARN log. `details` carries the path-specific extras (provider,
 * status, planId).
 */
export async function recordReactivatePlanMissing(
  orgId: string,
  subscriptionId: string | undefined,
  source: 'stripe_webhook' | 'admin' | 'marketplace',
  details: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  await createBillingEvent(orgId, 'subscription_updated', { reason: 'reactivate_plan_missing', ...details }, subscriptionId, actorId);
  incCounter('billing_reactivate_plan_missing_total', { source });
}

/** The active add-on bundle catalog (env-driven billing config). */
export function getBundleCatalog(): readonly BundleConfig[] {
  return getBillingConfig().bundles;
}

/** Whether purchasable add-on bundles are enabled (`BILLING_BUNDLES_ENABLED`).
 *  Default ON (opt-out) across all environments — mirrors `BILLING_ENABLED`'s
 *  style; set `false` to hide the add-on catalog. Self-service is still gated
 *  separately for AWS Marketplace (see `bundleSelfServiceAllowed`). */
export function bundlesEnabled(): boolean {
  return envBool('BILLING_BUNDLES_ENABLED', true);
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
