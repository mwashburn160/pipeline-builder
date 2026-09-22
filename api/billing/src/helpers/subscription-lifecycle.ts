// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createScheduler, type Scheduler, errorMessage, sendSystemNotification } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { config } from '../config.js';
import { syncProviderAddons } from './addon-prune.js';
import { billingServiceAuth, createBillingEvent } from './billing-helpers.js';
import { reconcileEntitlementDrift } from './entitlement-drift.js';
import { syncEntitlements } from './entitlement-sync.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from './subscription-status.js';
import { Plan } from '../models/plan.js';
import { Subscription, type SubscriptionDocument } from '../models/subscription.js';
import type { EntitlementResult } from '../providers/aws-marketplace-provider.js';
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
//
// Leader lock: every replica runs this scheduler, and each pass mutates money-
// and entitlement-bearing state (downgrades, reminders, drift re-syncs). The
// per-row atomic claims below keep a lock-less deployment correct; the lock keeps
// replicas from redundantly walking the same rows. TTL comfortably exceeds one
// pass and stays under the default hourly cadence so the next tick re-acquires.
const LOCK_TTL_MS = 10 * 60 * 1000;

const scheduler: Scheduler = createScheduler({
  name: 'subscription-lifecycle',
  intervalMs: config.lifecycleCheckIntervalMs,
  run: () => runWithTenantContext({ isSuperAdmin: true }, runLifecycleCheck),
  lock: { key: 'subscription-lifecycle', ttlMs: LOCK_TTL_MS },
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
  // A failed entitlement sync is retried by the durable-bus consumer
  // (startEntitlementSyncConsumer), not here; only the SILENT-drift pass
  // (out-of-band edits, which have no triggering event) runs below.
  await reconcileFailedProviderAddonSyncs();
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
      // CLAIM the lapse atomically BEFORE any side effect: the conditional update
      // only matches while the row is still an un-downgraded past_due, so exactly
      // one pass (replica, or a tick racing a payment recovery that clears the
      // marker) performs the downgrade. The marker is also what makes the row read
      // as developer-entitled to the entitlement-retry consumer and the drift
      // reconciler, so a failed sync below is re-driven to the RIGHT state.
      const claimedAt = new Date().toISOString();
      const claimed = await Subscription.findOneAndUpdate(
        { '_id': subscription._id, 'status': 'past_due', 'metadata.gracePeriodDowngradedAt': { $exists: false } },
        { $set: { 'metadata.gracePeriodDowngradedAt': claimedAt } },
      );
      if (!claimed) continue;
      subscription.metadata = { ...subscription.metadata, gracePeriodDowngradedAt: claimedAt };

      // Route through syncEntitlements (not syncTierToQuotaService directly) so
      // the seat leg runs too — a lapsed sub must lose paid seats — and so the
      // billing_quota_sync_failed_total metric + error log fire on failure. Empty
      // addons: a lapsed sub loses bundle entitlements as well.
      await syncEntitlements(subscription.orgId, 'developer', billingServiceAuth(subscription.orgId), subscription._id.toString(), []);

      // Lifecycle cron — no request user, so actorId is omitted (undefined).
      // We never fabricate an actor for system-initiated downgrades.
      await createBillingEvent(subscription.orgId, 'subscription_updated', {
        reason: 'grace_period_expired',
        gracePeriodDays: config.paymentGracePeriodDays,
        failedAttempts: subscription.failedPaymentAttempts,
        firstFailedAt: subscription.firstFailedAt?.toISOString(),
      }, subscription._id.toString());

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
  subscription: Pick<SubscriptionDocument, '_id' | 'orgId' | 'currentPeriodEnd'>,
  now: Date,
  detail: string,
): Promise<void> {
  // One row per (subscription, currentPeriodEnd, detail): a sub that stays stale
  // for days would otherwise write an identical investigation row EVERY tick.
  // The claim is atomic so concurrent passes can't both write it.
  const key = `${subscription.currentPeriodEnd.toISOString()}|${detail}`;
  const claimed = await Subscription.findOneAndUpdate(
    { '_id': subscription._id, 'metadata.lastStalePeriodEventKey': { $ne: key } },
    { $set: { 'metadata.lastStalePeriodEventKey': key } },
  );
  if (!claimed) return;
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

  // Include `trialing`: a trial whose period lapses without a Stripe
  // subscription.updated/deleted webhook (missed delivery) would otherwise never
  // be provider-verified and keep its trial entitlements indefinitely. `past_due`
  // is owned by the grace-period path; other statuses are terminal/irrelevant.
  //
  // `cancelAtPeriodEnd: true` rows are INCLUDED (not filtered out): a subscription
  // scheduled to cancel whose terminal `subscription.deleted` webhook is dropped
  // would otherwise keep its paid entitlements forever past the paid-through date.
  // The provider-verify branch below downgrades it when the provider reports it gone.
  const stale = await Subscription.find({
    status: { $in: ['active', 'trialing'] },
    currentPeriodEnd: { $lt: now },
  });

  if (stale.length === 0) return;

  // Count only — never a list of tenant ids in a WARN line (log volume + a
  // cross-tenant roster in the log pipeline). Per-row lines below carry the org.
  logger.warn('Found active subscriptions past their period end (possible missed webhooks)', {
    count: stale.length,
  });

  const provider = getPaymentProvider();

  for (const subscription of stale) {
    try {
      // Marketplace entitlements are normally SNS-driven, but a DROPPED terminal
      // `unsubscribe-success` SNS would otherwise leave the org on the paid tier
      // forever. Backstop it: verify against GetEntitlements (the customer id is
      // `metadata.awsCustomerIdentifier` — the org, never an AWS account id) and
      // downgrade when no active entitlement remains.
      if (subscription.metadata?.provider === 'aws-marketplace') {
        const mp = provider as unknown as { getEntitlements?: (id: string) => Promise<EntitlementResult[]> };
        const customerId = subscription.metadata?.awsCustomerIdentifier as string | undefined;
        if (!mp.getEntitlements || !customerId) {
          await recordStalePeriodEvent(subscription, now, mp.getEntitlements ? 'marketplace_no_customer_id' : 'marketplace_read_unsupported');
          continue;
        }
        if (subscription.metadata?.staleDowngradedAt) continue;

        let entitlements: EntitlementResult[];
        try {
          entitlements = await mp.getEntitlements(customerId);
        } catch (err) {
          // Inconclusive read — leave for a later tick rather than risk a false downgrade.
          logger.warn('Marketplace entitlement read failed for stale sub; deferring', {
            orgId: subscription.orgId, error: errorMessage(err),
          });
          await recordStalePeriodEvent(subscription, now, 'marketplace_entitlement_read_failed');
          continue;
        }

        const live = entitlements.filter((e) => e.isEntitled && (!e.expirationDate || e.expirationDate > now));
        if (live.length > 0) {
          // Entitlement is live — the terminal SNS was a false alarm / the contract
          // renewed. Advance the local period to the entitlement's own expiry so the
          // row leaves this scan (otherwise it re-matched and re-recorded forever).
          // An open-ended entitlement (no expirationDate) has no period to adopt →
          // record it (deduped per period) for investigation.
          const expiries = live.map((e) => e.expirationDate).filter((d): d is Date => d instanceof Date && d > now);
          if (expiries.length > 0 && expiries.length === live.length) {
            const periodEnd = new Date(Math.max(...expiries.map((d) => d.getTime())));
            await Subscription.updateOne({ _id: subscription._id }, { $set: { currentPeriodEnd: periodEnd } });
            subscription.currentPeriodEnd = periodEnd;
            incCounter('billing_stale_subscription_reconciled_total', { outcome: 'renewed' });
            logger.info('Stale marketplace sub still entitled — period advanced to entitlement expiry', {
              orgId: subscription.orgId, subscriptionId: subscription._id.toString(), currentPeriodEnd: periodEnd.toISOString(),
            });
          } else {
            await recordStalePeriodEvent(subscription, now, 'marketplace_still_entitled');
          }
          continue;
        }

        // No active entitlement — claim the downgrade atomically (status flip +
        // marker) BEFORE the side effects, so a concurrent pass can't double-run
        // it and a retried sync re-reads a canceled row.
        if (!(await claimStaleDowngrade(subscription))) continue;
        await syncEntitlements(subscription.orgId, 'developer', billingServiceAuth(subscription.orgId), subscription._id.toString(), []);
        await createBillingEvent(subscription.orgId, 'subscription_canceled', {
          reason: 'marketplace_entitlement_lapsed_missed_sns',
          previousStatus: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          detectedAt: now.toISOString(),
        }, subscription._id.toString());
        incCounter('billing_stale_subscription_reconciled_total', { outcome: 'downgraded' });
        logger.info('Stale marketplace sub verified as unentitled — downgraded to developer', {
          orgId: subscription.orgId, subscriptionId: subscription._id.toString(),
        });
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

        // Provider confirms the sub is gone. Claim the downgrade atomically (status
        // flip + marker) BEFORE the side effects, then route through
        // syncEntitlements (empty add-ons) so the seat leg + sync-failure metric
        // fire — same discipline as the grace path.
        if (!(await claimStaleDowngrade(subscription))) continue;
        await syncEntitlements(subscription.orgId, 'developer', billingServiceAuth(subscription.orgId), subscription._id.toString(), []);

        await createBillingEvent(subscription.orgId, 'subscription_canceled', {
          reason: 'provider_verified_cancel_missed_webhook',
          previousStatus: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          detectedAt: now.toISOString(),
        }, subscription._id.toString());

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

/**
 * Atomically flip a stale active/trialing row to `canceled` and stamp
 * `staleDowngradedAt` — only if no other pass already did. Returns whether THIS
 * pass owns the downgrade. Mirrors the in-memory doc so later reads agree.
 */
async function claimStaleDowngrade(
  subscription: Pick<SubscriptionDocument, '_id' | 'status' | 'metadata'>,
): Promise<boolean> {
  const at = new Date().toISOString();
  const claimed = await Subscription.findOneAndUpdate(
    { '_id': subscription._id, 'status': { $in: ['active', 'trialing'] }, 'metadata.staleDowngradedAt': { $exists: false } },
    { $set: { 'status': 'canceled', 'metadata.staleDowngradedAt': at } },
  );
  if (!claimed) return false;
  subscription.status = 'canceled';
  subscription.metadata = { ...subscription.metadata, staleDowngradedAt: at };
  return true;
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

  for (const subscription of upcoming) {
    try {
      const periodKey = formatDate(subscription.currentPeriodEnd);
      if (subscription.metadata?.lastRenewalReminder === periodKey) continue;

      // CLAIM this period's reminder atomically before sending, so two replicas
      // (or overlapping ticks) can't both send it. Released below if delivery fails.
      const previousKey = subscription.metadata?.lastRenewalReminder;
      const claimed = await Subscription.findOneAndUpdate(
        { '_id': subscription._id, 'metadata.lastRenewalReminder': { $ne: periodKey } },
        { $set: { 'metadata.lastRenewalReminder': periodKey } },
      );
      if (!claimed) continue;

      const plan = await Plan.findById(subscription.planId);
      const planName = plan?.name || 'your plan';
      const renewDate = subscription.currentPeriodEnd.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      // A SYSTEM-authored notice into the org's inbox.
      const delivered = await sendSystemNotification({
        recipientOrgId: subscription.orgId,
        subject: `Subscription renewal in ${reminderDays} days`,
        content: `Your ${planName} subscription (${subscription.interval}) will renew on ${renewDate}. `
        + 'If you need to make changes, visit your billing settings.',
        priority: 'normal',
      }, { service: config.messageService });

      // Only keep the per-period dedupe claim once the message service ACCEPTED
      // the reminder; otherwise release it so the next tick retries instead of
      // silently recording an undelivered reminder.
      if (!delivered) {
        logger.warn('Renewal reminder not delivered — will retry next tick', { orgId: subscription.orgId });
        await releaseRenewalReminderClaim(subscription._id, periodKey, previousKey);
        continue;
      }

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

// ── 4b. Provider Add-on Sync Reconciliation ───────────────

/**
 * Re-drive PROVIDER add-on line-item reconciliations that failed-open during a
 * transient provider (Stripe) outage. When an auto-prune (tier upgrade) or a
 * user add/remove drops a bundle, `syncProviderAddons` deletes the Stripe line
 * item best-effort — a failure there is only local (the customer keeps being
 * billed for the pruned bundle) and, unlike the entitlement leg, had no durable
 * retry. `syncProviderAddons` stamps `metadata.providerAddonSyncPending` on
 * failure (and clears it on the next success), so this pass finds every ACTIVE
 * marked sub and re-calls `syncProviderAddons` with the sub's CURRENT (already
 * reduced) add-ons — idempotent: it rebuilds the provider's bundle line items
 * from that list, dropping exactly the pruned ones. The marker clear/set happens
 * inside syncProviderAddons, so this pass is self-clearing: a still-failing sub
 * keeps the marker for the next tick, a recovered one drops it. Marketplace is
 * exempt (its syncAddons is a no-op that never fails, so it never gets marked).
 */
async function reconcileFailedProviderAddonSyncs(): Promise<void> {
  const pending = await Subscription.find({
    'status': { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
    'metadata.providerAddonSyncPending': true,
  });

  if (pending.length === 0) return;

  logger.info('Reconciling subscriptions with a pending provider add-on sync', {
    count: pending.length,
  });

  for (const subscription of pending) {
    try {
      // Idempotent re-drive from the CURRENT reduced add-on set. syncProviderAddons
      // clears the marker on success (and re-sets it on another failure). Threading
      // the subscriptionId is what lets it manage the marker; source tags the metric.
      await syncProviderAddons(
        subscription.externalId,
        subscription.addons ?? [],
        subscription.interval,
        subscription.orgId,
        subscription._id.toString(),
        'reconcile',
      );
    } catch (err) {
      // syncProviderAddons is fail-open (never throws), but guard defensively so
      // one sub can't abort the pass.
      logger.error('Error reconciling provider add-on sync', {
        orgId: subscription.orgId,
        subscriptionId: subscription._id.toString(),
        error: errorMessage(err),
      });
    }
  }
}

/**
 * Undo an undelivered reminder's claim (only if it's still OURS) so the next tick
 * retries it, restoring the prior period's key when there was one.
 */
async function releaseRenewalReminderClaim(id: SubscriptionDocument['_id'], periodKey: string, previousKey: unknown): Promise<void> {
  try {
    await Subscription.updateOne(
      { '_id': id, 'metadata.lastRenewalReminder': periodKey },
      typeof previousKey === 'string'
        ? { $set: { 'metadata.lastRenewalReminder': previousKey } }
        : { $unset: { 'metadata.lastRenewalReminder': '' } },
    );
  } catch (err) {
    logger.warn('Failed to release renewal-reminder claim; reminder for this period will be skipped', { error: errorMessage(err) });
  }
}

/** Format a date as YYYY-MM-DD for deduplication keys. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
