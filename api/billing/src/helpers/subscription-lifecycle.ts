// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createSafeClient, createScheduler, type Scheduler, errorMessage, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { config } from '../config.js';
import { createBillingEvent, effectiveEntitlements, getBundleCatalog, syncEntitlements } from './billing-helpers.js';
import { computeEntitlementDrift, readActualEntitlements } from './entitlement-drift.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('subscription-lifecycle');

/**
 * Background job that runs periodically to manage subscription lifecycle:
 *
 * 1. **Grace period expiry**: Downgrade orgs whose payment failure grace period has expired
 * 2. **Expired subscription detection**: Catch subscriptions that stayed 'active' past their
 *    currentPeriodEnd (e.g. missed webhooks)
 * 3. **Renewal reminders**: Notify orgs approaching their billing period end
 */

// Defensive tenant scope: today this cron only touches Mongo (Subscription,
// Plan), so no RLS GUCs are needed. But if a future change adds a Postgres read
// here, it would silently get an RLS denial without an active tenant scope. Wrap
// the whole cron in a sysadmin scope to match the other multi-org crons
// (compliance scan-scheduler, audit-prune).
const scheduler: Scheduler = createScheduler({
  name: 'subscription-lifecycle',
  intervalMs: config.lifecycleCheckIntervalMs,
  run: () => runWithTenantContext({ isSuperAdmin: true }, runLifecycleCheck),
});

/** Start the periodic subscription lifecycle checker. Safe to call multiple times. */
export function startSubscriptionLifecycleChecker(): void { scheduler.start(); }

/** Stop the lifecycle checker (for graceful shutdown). */
export function stopSubscriptionLifecycleChecker(): void { scheduler.stop(); }

/** Run all lifecycle checks. */
async function runLifecycleCheck(): Promise<void> {
  await checkGracePeriodExpiry();
  await checkExpiredSubscriptions();
  await sendRenewalReminders();
  await reconcileFailedEntitlementSyncs();
  // Runs LAST: the low-frequency, bounded silent-drift pass. Kept at the end so
  // it doesn't disturb the earlier legs' sequential-mock ordering in tests.
  await reconcileEntitlementDrift();
}

// ── 1. Grace Period Expiry ────────────────────────────────

/**
 * Find subscriptions in 'past_due' status whose grace period has expired,
 * and downgrade them to the developer tier.
 */
async function checkGracePeriodExpiry(): Promise<void> {
  const gracePeriodMs = config.paymentGracePeriodDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - gracePeriodMs);

  // Exclude subs already downgraded this lapse. Status stays 'past_due' (the
  // recovery signal handlePaymentSucceeded keys on), so without a durable marker
  // these rows would re-match every tick — re-emitting billing_events and
  // re-running the downgrade forever. handlePaymentSucceeded clears the marker
  // when a sub recovers to 'active', so a future lapse re-downgrades.
  const expired = await Subscription.find({
    'status': 'past_due',
    'firstFailedAt': { $lte: cutoff },
    'metadata.gracePeriodDowngradedAt': { $exists: false },
  });

  for (const subscription of expired) {
    try {
      // Route through syncEntitlements (not syncTierToQuotaService directly) so
      // the seat leg runs too — a lapsed sub must lose paid seats — and so the
      // billing_quota_sync_failed_total metric + error log fire on failure. Empty
      // addons: a lapsed sub loses bundle entitlements as well.
      const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId: subscription.orgId, role: 'owner' });
      await syncEntitlements(subscription.orgId, 'developer', serviceAuth, subscription._id.toString(), []);

      await createBillingEvent(subscription.orgId, 'subscription_updated', {
        reason: 'grace_period_expired',
        gracePeriodDays: config.paymentGracePeriodDays,
        failedAttempts: subscription.failedPaymentAttempts,
        firstFailedAt: subscription.firstFailedAt?.toISOString(),
      }, subscription._id.toString());

      // Durable dedupe marker — set AFTER the side-effects so a mid-run failure
      // (which throws before this) leaves the row un-marked and retryable next tick.
      subscription.metadata = {
        ...subscription.metadata,
        gracePeriodDowngradedAt: new Date().toISOString(),
      };
      await subscription.save();

      logger.info('Grace period expired — org downgraded', {
        orgId: subscription.orgId,
        firstFailedAt: subscription.firstFailedAt?.toISOString(),
        failedAttempts: subscription.failedPaymentAttempts,
      });
    } catch (err) {
      logger.error('Failed to downgrade after grace period', {
        orgId: subscription.orgId,
        error: errorMessage(err),
      });
    }
  }
}

// ── 2. Expired Subscription Detection ─────────────────────

/**
 * Record a stale-active subscription for investigation WITHOUT downgrading. Used
 * whenever the provider can't give us a safe, definitive verdict (marketplace —
 * SNS-driven; no read capability; an inconclusive lookup; or the provider still
 * reports it active but hasn't advanced the period). Preserves the original
 * `period_end_passed_without_renewal` signal and carries a `detail` sub-reason.
 */
async function recordStalePeriodEvent(
  subscription: { orgId: string; currentPeriodEnd: Date; _id: { toString(): string } },
  now: Date,
  detail: string,
): Promise<void> {
  await createBillingEvent(subscription.orgId, 'subscription_updated', {
    reason: 'period_end_passed_without_renewal',
    detail,
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    detectedAt: now.toISOString(),
  }, subscription._id.toString());
}

/**
 * Find subscriptions that are still 'active' but past their currentPeriodEnd —
 * the classic missed `customer.subscription.deleted` (or renewal) webhook. A
 * stale-active row that just sits here would keep the org on a paid tier/seats
 * forever while the provider has already stopped billing, so we VERIFY each one
 * against the payment provider (the source of truth) before acting:
 *
 * - Provider reports it GONE (`canceled`)  → mark local `canceled` + downgrade
 *   to developer via `syncEntitlements` (empty add-ons), reusing the grace
 *   path's dedupe discipline. Flipping status also drops the row from this scan.
 * - Provider reports it RENEWED (period advanced into the future) → the webhook
 *   was merely late: advance `currentPeriodEnd` locally, do NOT downgrade.
 * - Anything else (marketplace/SNS-driven, no read capability, inconclusive
 *   lookup, or still-active-but-not-advanced) → record for investigation, never
 *   downgrade. This must NOT false-downgrade a genuinely-renewed sub.
 *
 * Idempotent + bounded: the downgrade flips status out of the query and stamps a
 * durable marker; the renewal advances the period out of the query.
 */
async function checkExpiredSubscriptions(): Promise<void> {
  const now = new Date();

  const stale = await Subscription.find({
    status: 'active',
    currentPeriodEnd: { $lt: now },
    cancelAtPeriodEnd: false,
  });

  if (stale.length === 0) return;

  logger.warn('Found active subscriptions past their period end (possible missed webhooks)', {
    count: stale.length,
    orgIds: stale.map(s => s.orgId),
  });

  const provider = getPaymentProvider();

  for (const subscription of stale) {
    try {
      // Marketplace entitlements are SNS-driven — the app never provider-verifies
      // or downgrades them here (the SNS handler owns their lifecycle).
      if (subscription.metadata?.provider === 'aws-marketplace') {
        await recordStalePeriodEvent(subscription, now, 'marketplace_sns_driven');
        continue;
      }

      // Provider can't be read (no capability) or we have no external handle —
      // can't verify, so record for investigation but never downgrade blindly.
      if (!provider.getSubscription || !subscription.externalId) {
        await recordStalePeriodEvent(
          subscription, now,
          provider.getSubscription ? 'no_external_id' : 'provider_read_unsupported',
        );
        continue;
      }

      const view = await provider.getSubscription(subscription.externalId);
      if (!view) {
        // Provider couldn't resolve it in a safe-to-act-on way — leave it for a
        // later tick rather than risk a false downgrade.
        await recordStalePeriodEvent(subscription, now, 'provider_lookup_inconclusive');
        continue;
      }

      if (view.status === 'canceled') {
        // Durable dedupe (belt-and-suspenders alongside the status flip): skip if
        // a prior tick already reconciled this exact lapse.
        if (subscription.metadata?.staleDowngradedAt) continue;

        // Provider confirms the sub is gone. Route through syncEntitlements (empty
        // add-ons) so the seat leg + sync-failure metric fire — same discipline as
        // the grace path — then flip status so the row leaves this scan.
        const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId: subscription.orgId, role: 'owner' });
        await syncEntitlements(subscription.orgId, 'developer', serviceAuth, subscription._id.toString(), []);

        await createBillingEvent(subscription.orgId, 'subscription_canceled', {
          reason: 'provider_verified_cancel_missed_webhook',
          previousStatus: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          detectedAt: now.toISOString(),
        }, subscription._id.toString());

        subscription.status = 'canceled';
        subscription.metadata = {
          ...subscription.metadata,
          staleDowngradedAt: new Date().toISOString(),
        };
        await subscription.save();

        incCounter('billing_stale_subscription_reconciled_total', { outcome: 'downgraded' });
        logger.info('Stale-active sub provider-verified as canceled — downgraded to developer', {
          orgId: subscription.orgId,
          subscriptionId: subscription._id.toString(),
        });
      } else if (view.currentPeriodEnd && view.currentPeriodEnd > now) {
        // Provider renewed — the webhook was merely late. Advance the local
        // period (drops the row from this scan) and do NOT downgrade.
        subscription.currentPeriodEnd = view.currentPeriodEnd;
        await subscription.save();

        await createBillingEvent(subscription.orgId, 'subscription_updated', {
          reason: 'provider_verified_renewal_late_webhook',
          currentPeriodEnd: view.currentPeriodEnd.toISOString(),
          detectedAt: now.toISOString(),
        }, subscription._id.toString());

        incCounter('billing_stale_subscription_reconciled_total', { outcome: 'renewed' });
        logger.info('Stale-active sub provider-verified as renewed — period advanced (late webhook)', {
          orgId: subscription.orgId,
          subscriptionId: subscription._id.toString(),
          currentPeriodEnd: view.currentPeriodEnd.toISOString(),
        });
      } else {
        // Provider still reports it active/trialing but with no advanced period —
        // genuinely ambiguous. Record for investigation; never downgrade.
        await recordStalePeriodEvent(subscription, now, 'provider_active_no_period_advance');
      }
    } catch (err) {
      // A transient provider/read error must NOT downgrade — log and retry next tick.
      logger.error('Failed to reconcile stale-active subscription', {
        orgId: subscription.orgId,
        subscriptionId: subscription._id.toString(),
        error: errorMessage(err),
      });
    }
  }
}

// ── 3. Renewal Reminders ──────────────────────────────────

/**
 * Send a notification to orgs whose subscription renews within the
 * configured reminder window (RENEWAL_REMINDER_DAYS).
 */
async function sendRenewalReminders(): Promise<void> {
  const reminderDays = config.renewalReminderDays;
  const now = new Date();
  const reminderWindow = new Date(now.getTime() + reminderDays * 24 * 60 * 60 * 1000);

  // Dedupe by the subscription's own currentPeriodEnd: each period gets
  // exactly one reminder. Keying off `reminderWindow` (which moves every run)
  // would re-send on the next cron tick.
  const upcoming = await Subscription.find({
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: { $gt: now, $lte: reminderWindow },
  });

  if (upcoming.length === 0) return;

  const messageClient = createSafeClient({
    host: config.messageService.host,
    port: config.messageService.port,
  });

  for (const subscription of upcoming) {
    try {
      const periodKey = formatDate(subscription.currentPeriodEnd);
      if (subscription.metadata?.lastRenewalReminder === periodKey) continue;

      const plan = await Plan.findById(subscription.planId);
      const planName = plan?.name || 'your plan';
      const renewDate = subscription.currentPeriodEnd.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      await messageClient.post('/messages', {
        // Caller's org identity is taken from the JWT — don't pass orgId/
        // senderOrgId, the message service rejects them. recipientOrgId
        // is the target tenant. Use 'conversation' (not 'announcement',
        // which message-service only allows for recipientOrgId='*').
        recipientOrgId: subscription.orgId,
        messageType: 'conversation',
        subject: `Subscription renewal in ${reminderDays} days`,
        content: `Your ${planName} subscription (${subscription.interval}) will renew on ${renewDate}. `
          + 'If you need to make changes, visit your billing settings.',
        priority: 'normal',
      }, {
        headers: {
          'x-internal-service': 'true',
          'x-org-id': SYSTEM_ORG_ID,
          'authorization': getServiceAuthHeader({ serviceName: 'billing', orgId: SYSTEM_ORG_ID, role: 'member' }),
        },
      });

      subscription.metadata = {
        ...subscription.metadata,
        lastRenewalReminder: periodKey,
      };
      await subscription.save();

      logger.info('Renewal reminder sent', {
        orgId: subscription.orgId,
        renewDate,
        planName,
      });
    } catch (err) {
      logger.warn('Failed to send renewal reminder', {
        orgId: subscription.orgId,
        error: errorMessage(err),
      });
    }
  }
}

// ── 4. Entitlement Sync Reconciliation ────────────────────

/**
 * Re-drive entitlement syncs that failed-open during a transient quota/platform
 * outage. `syncEntitlements` fails open (logs + audits + a metric, returns a
 * swallowed `false`) so a brief outage during an upgrade/add-on leaves local
 * billing state (e.g. Pro + bundles) diverged from the enforced caps (old tier)
 * with nothing re-attempting it. Every sync call site stamps
 * `metadata.entitlementSyncPending = true` on failure (and clears it on the next
 * success) via syncEntitlements, so this pass simply finds every ACTIVE sub still
 * carrying the marker and re-syncs it. The marker clear happens inside
 * syncEntitlements on success — so this pass is idempotent and self-clearing: a
 * still-failing leg keeps the marker for the next tick, a recovered one drops it.
 */
async function reconcileFailedEntitlementSyncs(): Promise<void> {
  const pending = await Subscription.find({
    'status': 'active',
    'metadata.entitlementSyncPending': true,
  });

  if (pending.length === 0) return;

  logger.info('Reconciling subscriptions with a pending entitlement sync', {
    count: pending.length,
    orgIds: pending.map(s => s.orgId),
  });

  for (const subscription of pending) {
    try {
      const plan = await Plan.findById(subscription.planId);
      if (!plan) {
        logger.error('Cannot reconcile entitlement sync — plan not found', {
          orgId: subscription.orgId,
          subscriptionId: subscription._id.toString(),
          planId: subscription.planId,
        });
        continue;
      }

      // Re-drive the SAME two-target sync the original mutation attempted:
      // effective tier + current add-ons, root-scoped, with a fresh service
      // token. syncEntitlements clears the pending marker on success.
      const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId: subscription.orgId, role: 'owner' });
      const ok = await syncEntitlements(
        subscription.orgId, plan.tier, serviceAuth, subscription._id.toString(), subscription.addons ?? [],
      );

      if (ok) {
        logger.info('Entitlement sync reconciled', {
          orgId: subscription.orgId,
          subscriptionId: subscription._id.toString(),
        });
      } else {
        logger.warn('Entitlement sync still failing after reconcile attempt — will retry next tick', {
          orgId: subscription.orgId,
          subscriptionId: subscription._id.toString(),
        });
      }
    } catch (err) {
      logger.error('Error reconciling entitlement sync', {
        orgId: subscription.orgId,
        error: errorMessage(err),
      });
    }
  }
}

// ── 5. Cross-Store Entitlement-Drift Reconciliation ───────

/**
 * Low-frequency, BOUNDED pass that catches SILENT entitlement drift — the case
 * the Tier-1 reconciler can't see. reconcileFailedEntitlementSyncs re-drives
 * syncs that KNOWINGLY failed (they carry `metadata.entitlementSyncPending`).
 * This pass finds subs whose sync returned success but whose ENFORCED state has
 * since diverged from what the Subscription (tier + add-ons) says it should be:
 * an out-of-band edit in the quota/platform store, a sync that didn't take
 * effect, a manual override, etc.
 *
 * Billing's Subscription is the source of truth. For each candidate we compute
 * the EXPECTED entitlements (`effectiveEntitlements`), read the ACTUAL enforced
 * state (quota limits from the quota service + the seat limit from platform),
 * and compare. On any mismatch we re-drive the SAME idempotent `syncEntitlements`
 * path (which also clears the pending marker) + emit
 * `billing_entitlement_drift_total`. On a clean match we stamp
 * `metadata.lastReconciledAt` and do nothing else.
 *
 * BOUNDED two ways so a large customer base is amortized, not scanned every tick:
 *   1. a per-tick cap (`config.entitlementDriftMaxPerTick`), and
 *   2. a per-sub `metadata.lastReconciledAt` gate — a sub reconciled within the
 *      last `config.entitlementDriftIntervalMs` (~daily) is skipped by the query.
 * `lastReconciledAt` is stamped after every completed check (match OR drift), so
 * each sub rotates back into the window at most ~once per interval. A read
 * failure leaves it UN-stamped, so it's retried next tick (never falsely re-synced).
 *
 * FAIL-SOFT: a store read failure for one sub logs + skips that sub — an
 * unreachable store is NOT "drift". The pass never throws.
 *
 * NOTE ON COVERAGE: platform exposes no clean service read for an org's
 * `featureEntitlements`, so features are NOT compared here — only the 9 tracked
 * quota limits + seats. A future platform read would close that gap.
 */
async function reconcileEntitlementDrift(): Promise<void> {
  // Gate: only subs never reconciled, or last reconciled before the interval
  // cutoff. Combined with the per-tick cap this amortizes the whole base.
  const cutoff = new Date(Date.now() - config.entitlementDriftIntervalMs).toISOString();
  const candidates = await Subscription.find(
    {
      status: 'active',
      $or: [
        { 'metadata.lastReconciledAt': { $exists: false } },
        { 'metadata.lastReconciledAt': { $lte: cutoff } },
      ],
    },
    null,
    // Bound the scan at the DB level — never pull the whole ACTIVE set.
    { limit: config.entitlementDriftMaxPerTick },
  );

  if (candidates.length === 0) return;

  for (const subscription of candidates) {
    const subscriptionId = subscription._id.toString();
    try {
      const plan = await Plan.findById(subscription.planId);
      if (!plan) {
        logger.error('Cannot drift-check entitlements — plan not found', {
          orgId: subscription.orgId, subscriptionId, planId: subscription.planId,
        });
        continue;
      }

      const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId: subscription.orgId, role: 'owner' });
      const addons = subscription.addons ?? [];

      // EXPECTED (from the sub) vs ACTUAL (enforced) — the compare is pure; the
      // read is fail-soft (null ⇒ a store was unreachable).
      const { limits: expected } = effectiveEntitlements(plan.tier, addons, getBundleCatalog());
      const actual = await readActualEntitlements(subscription.orgId, serviceAuth);
      if (!actual) {
        // A store read failed — an outage is NOT drift. Skip WITHOUT stamping so
        // this sub is retried next tick; never re-sync on an unreachable store.
        logger.warn('Entitlement drift check skipped — enforced-state read failed', {
          orgId: subscription.orgId, subscriptionId,
        });
        continue;
      }

      const drift = computeEntitlementDrift(expected, actual);

      if (drift.status === 'drift') {
        logger.warn('Entitlement drift detected — re-syncing enforced state', {
          orgId: subscription.orgId, subscriptionId, tier: plan.tier, drifted: drift.drifted,
        });
        // Re-drive the SAME idempotent two-target sync (clears the pending marker
        // on success; sets it on failure for the Tier-1 reconciler to retry).
        await syncEntitlements(subscription.orgId, plan.tier, serviceAuth, subscriptionId, addons);
        for (const dimension of drift.dimensions) {
          incCounter('billing_entitlement_drift_total', { dimension });
        }
      }

      // Stamp on a completed check (match OR post-resync) so this sub drops out
      // of the query for the next interval. Surgical dot-path so a concurrent
      // metadata write (grace / pending / renewal markers) isn't clobbered.
      await Subscription.updateOne(
        { _id: subscriptionId },
        { $set: { 'metadata.lastReconciledAt': new Date().toISOString() } },
      );
    } catch (err) {
      // Never let one sub's failure abort the pass.
      logger.error('Error reconciling entitlement drift', {
        orgId: subscription.orgId, subscriptionId, error: errorMessage(err),
      });
    }
  }
}

/** Format a date as YYYY-MM-DD for deduplication keys. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
