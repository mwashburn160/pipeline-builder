// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Paid-signup billing provisioning + reconcile.
 *
 * Closes the fail-open gap where a customer who selected a paid plan at signup
 * would end up PERMANENTLY developer-tier with no subscription if billing was
 * unavailable at that moment: the old fire-and-forget call swallowed the error
 * (catch → warn) and nothing ever retried it.
 *
 * Flow:
 *   1. {@link provisionBillingSubscription} — called fire-and-forget from the
 *      register controller. POSTs the subscription with a couple of short-backoff
 *      retries; on persistent failure it persists a DURABLE marker on the org
 *      (`pendingBillingPlanId`) instead of losing the intent. Never throws —
 *      registration success is independent of billing latency.
 *   2. {@link reconcilePendingBillingSubscriptions} — a lightweight pass (boot
 *      drain + periodic interval, wired in index.ts alongside the RBAC backfill)
 *      that re-attempts every marked org and clears the marker on success.
 *
 * The org's `tier` is NEVER granted locally here — it stays developer until
 * billing actually provisions the subscription (no free-paid-tier). The marker
 * only guarantees the provisioning eventually happens (or is operator-visible).
 */

import { createLogger, createSafeClient, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { authService } from './auth-service.js';
import { config } from '../config/index.js';
import { incCounter } from '../observability/metrics.js';

const logger = createLogger('billing-provision');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Summary of a reconcile pass (for logging + tests). */
export interface BillingReconcileSummary {
  scanned: number;
  reconciled: number;
  stillPending: number;
}

/** Single billing subscription POST (no retry). Throws on any failure. */
async function postSubscription(orgId: string, planId: string): Promise<void> {
  const client = createSafeClient({
    host: config.billing.serviceHost,
    port: config.billing.servicePort,
    timeout: config.billing.serviceTimeout,
  });

  await client.post('/billing/subscriptions', { planId, interval: 'monthly' }, {
    headers: {
      'x-org-id': orgId,
      'authorization': getServiceAuthHeader({ serviceName: 'platform', orgId, role: 'member' }),
    },
  });
}

/**
 * Attempt the billing POST with a couple of short-backoff retries. Returns true
 * if the subscription was provisioned, false once all attempts are exhausted
 * (billing down/unreachable). Never throws.
 */
async function attemptWithRetry(orgId: string, planId: string): Promise<boolean> {
  const attempts = Math.max(1, config.billing.provisionRetryAttempts);
  const baseMs = Math.max(0, config.billing.provisionRetryBaseMs);

  for (let i = 1; i <= attempts; i += 1) {
    try {
      await postSubscription(orgId, planId);
      return true;
    } catch (error) {
      const isLast = i === attempts;
      logger.warn('Billing subscription attempt failed', {
        orgId,
        planId,
        attempt: i,
        of: attempts,
        willRetry: !isLast,
        error: error instanceof Error ? error.message : String(error),
      });
      if (isLast) return false;
      // Linear backoff (base, 2×base, …) — short by design so a healthy billing
      // that briefly blipped is picked up on the next attempt without stalling
      // the caller (this runs fire-and-forget off the register path).
      await sleep(baseMs * i);
    }
  }
  return false;
}

/**
 * Provision a billing subscription for a NEWLY registered org (fire-and-forget).
 * On persistent failure, persist the durable pending marker so the reconcile
 * pass retries it. NEVER throws — registration must succeed regardless of
 * billing availability.
 *
 * Caller is responsible for the `config.billing.enabled` gate: when billing is
 * disabled there is nothing to reconcile to, so no marker is set (today's
 * behavior is preserved).
 */
export async function provisionBillingSubscription(orgId: string, planId: string): Promise<void> {
  // Defense in depth alongside the controller's gate: when billing is disabled
  // there is no service to provision or reconcile against, so we must NOT set a
  // marker (it would never clear). Preserves today's billing-off behavior.
  if (!config.billing.enabled) return;

  const ok = await attemptWithRetry(orgId, planId);

  if (ok) {
    // Clear any pre-existing marker (defensive: a reconcile pass could have
    // raced the original signup, or an earlier attempt already marked it).
    await authService.clearPendingBillingPlan(orgId).catch((err) => {
      logger.warn('Failed to clear pending-billing marker after success (non-fatal)', {
        orgId, error: err instanceof Error ? err.message : String(err),
      });
    });
    logger.info('Billing subscription created for new org', { orgId, planId });
    incCounter('platform_billing_provision_total', { outcome: 'success' });
    return;
  }

  // Fail-open on the registration response, but never silently lose the paid
  // intent: persist the durable marker for the reconcile pass to pick up.
  try {
    await authService.setPendingBillingPlan(orgId, planId);
    logger.warn('Billing bootstrap failed; persisted pending marker for reconcile', { orgId, planId });
    incCounter('platform_billing_provision_total', { outcome: 'deferred' });
  } catch (err) {
    // Even the marker write failed (Mongo blip) — surface loudly; the org is now
    // at risk of the silent-developer-tier gap. Still non-fatal to registration.
    logger.error('Billing bootstrap AND pending-marker persistence failed', {
      orgId, planId, error: err instanceof Error ? err.message : String(err),
    });
    incCounter('platform_billing_provision_total', { outcome: 'lost' });
  }
}

/**
 * Reconcile pass: retry the billing bootstrap for every org carrying a pending
 * marker, clearing the marker on success. Runs at boot + on a guarded interval
 * (index.ts). Idempotent + cheap on the common no-op (no marked orgs).
 *
 * No-ops when billing is disabled (nothing to reconcile to).
 */
export async function reconcilePendingBillingSubscriptions(): Promise<BillingReconcileSummary> {
  if (!config.billing.enabled) {
    return { scanned: 0, reconciled: 0, stillPending: 0 };
  }

  const pending = await authService.listPendingBillingOrgs();
  if (pending.length === 0) {
    return { scanned: 0, reconciled: 0, stillPending: 0 };
  }

  let reconciled = 0;
  for (const { orgId, planId } of pending) {
    const ok = await attemptWithRetry(orgId, planId);
    if (ok) {
      await authService.clearPendingBillingPlan(orgId);
      reconciled += 1;
      incCounter('platform_billing_reconcile_total', { outcome: 'success' });
      logger.info('Reconciled pending billing subscription', { orgId, planId });
    } else {
      incCounter('platform_billing_reconcile_total', { outcome: 'still_pending' });
      logger.warn('Billing reconcile still pending (billing unavailable)', { orgId, planId });
    }
  }

  const summary: BillingReconcileSummary = {
    scanned: pending.length,
    reconciled,
    stillPending: pending.length - reconciled,
  };
  logger.info('Billing reconcile pass complete', summary);
  return summary;
}
