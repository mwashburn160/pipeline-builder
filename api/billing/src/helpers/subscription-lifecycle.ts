// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createSafeClient, errorMessage } from '@mwashburn160/api-core';
import { config } from '../config';
import { createBillingEvent, syncTierToQuotaService } from './billing-helpers';
import { Plan } from '../models/plan';
import { Subscription } from '../models/subscription';

const logger = createLogger('subscription-lifecycle');

/**
 * Background job that runs periodically to manage subscription lifecycle:
 *
 * 1. **Grace period expiry**: Downgrade orgs whose payment failure grace period has expired
 * 2. **Expired subscription detection**: Catch subscriptions that stayed 'active' past their
 *    currentPeriodEnd (e.g. missed webhooks)
 * 3. **Renewal reminders**: Notify orgs approaching their billing period end
 */

let lifecycleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic subscription lifecycle checker.
 * Safe to call multiple times — only starts one timer.
 */
export function startSubscriptionLifecycleChecker(): void {
  if (lifecycleTimer) return;

  const intervalMs = config.lifecycleCheckIntervalMs;

  // Run immediately on startup, then on interval
  runLifecycleCheck().catch((err) =>
    logger.error('Initial lifecycle check failed', { error: errorMessage(err) }),
  );

  lifecycleTimer = setInterval(() => {
    runLifecycleCheck().catch((err) =>
      logger.error('Lifecycle check failed', { error: errorMessage(err) }),
    );
  }, intervalMs);
  lifecycleTimer.unref();

  logger.info('Subscription lifecycle checker started', { intervalMs });
}

/** Stop the lifecycle checker (for graceful shutdown). */
export function stopSubscriptionLifecycleChecker(): void {
  if (lifecycleTimer) {
    clearInterval(lifecycleTimer);
    lifecycleTimer = null;
  }
}

/** Run all lifecycle checks. */
async function runLifecycleCheck(): Promise<void> {
  await checkGracePeriodExpiry();
  await checkExpiredSubscriptions();
  await sendRenewalReminders();
}

// ── 1. Grace Period Expiry ────────────────────────────────

/**
 * Find subscriptions in 'past_due' status whose grace period has expired,
 * and downgrade them to the developer tier.
 */
async function checkGracePeriodExpiry(): Promise<void> {
  const gracePeriodMs = config.paymentGracePeriodDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - gracePeriodMs);

  const expired = await Subscription.find({
    status: 'past_due',
    firstFailedAt: { $lte: cutoff },
  });

  for (const subscription of expired) {
    try {
      await syncTierToQuotaService(subscription.orgId, 'developer', '');

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
 * Find subscriptions that are still 'active' but past their currentPeriodEnd.
 * This catches missed webhooks — if Stripe renewed the subscription but we
 * never got the webhook, the subscription appears expired locally.
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

  // Don't auto-cancel — just log. These likely need the webhook to arrive
  // or a manual Stripe dashboard check. Mark them for investigation.
  for (const subscription of stale) {
    await createBillingEvent(subscription.orgId, 'subscription_updated', {
      reason: 'period_end_passed_without_renewal',
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      detectedAt: now.toISOString(),
    }, subscription._id.toString());
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

  // Find active subscriptions renewing within the window that haven't been reminded
  const upcoming = await Subscription.find({
    'status': 'active',
    'cancelAtPeriodEnd': false,
    'currentPeriodEnd': { $gt: now, $lte: reminderWindow },
    'metadata.lastRenewalReminder': { $ne: formatDate(reminderWindow) },
  });

  if (upcoming.length === 0) return;

  const messageClient = createSafeClient({
    host: config.messageService.host,
    port: config.messageService.port,
  });

  for (const subscription of upcoming) {
    try {
      const plan = await Plan.findById(subscription.planId);
      const planName = plan?.name || 'your plan';
      const renewDate = subscription.currentPeriodEnd.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      await messageClient.post('/messages', {
        orgId: subscription.orgId,
        senderOrgId: 'system',
        recipientOrgId: subscription.orgId,
        subject: `Subscription renewal in ${reminderDays} days`,
        body: `Your ${planName} subscription (${subscription.interval}) will renew on ${renewDate}. `
          + 'If you need to make changes, visit your billing settings.',
        messageType: 'announcement',
        priority: 'normal',
      }, {
        headers: { 'x-internal-service': 'true', 'x-org-id': 'system' },
      });

      // Mark as reminded so we don't send duplicates
      subscription.metadata = {
        ...subscription.metadata,
        lastRenewalReminder: formatDate(reminderWindow),
      };
      await subscription.save();

      logger.info('Renewal reminder sent', {
        orgId: subscription.orgId,
        renewDate,
        planName,
      });
    } catch (err) {
      logger.debug('Failed to send renewal reminder', {
        orgId: subscription.orgId,
        error: errorMessage(err),
      });
    }
  }
}

/** Format a date as YYYY-MM-DD for deduplication keys. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
