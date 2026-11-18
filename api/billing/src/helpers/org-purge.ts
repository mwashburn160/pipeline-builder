// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tear one org's billing state down: cancel its live subscriptions at the
 * payment provider, IMMEDIATELY, then drop its subscriptions and billing events.
 *
 * Immediate, not at period end: the cascade leg fires only at the FINAL purge
 * (platform's `purgeExpiredOrgs`, after the soft-delete restore window has
 * lapsed), so there is no org left to keep serving until the period ends — a
 * period-end cancel kept charging an org that no longer exists. Stripe's
 * `subscriptions.cancel` is called without proration or `invoice_now`, so no
 * credit and no automatic refund is issued. "Live" is every status that is not
 * terminal, `incomplete` included: cancelling an incomplete Stripe subscription
 * voids its open first invoice, which dropping the row alone left payable.
 *
 * Shared by the org-purge cascade leg (`BILLING_INTERNAL.purgeOrg`, platform's
 * durable outbox) and the billing admin page's "Purge"
 * (`DELETE /billing/subscriptions/by-org/:orgId`), so the two cannot disagree
 * about what a purge leaves behind.
 *
 * A subscription whose provider cancel FAILS is KEPT, with its events, and
 * counted in `retained`. Dropping it anyway — what this sweep used to do — wiped
 * the only record of the provider's `externalId` while the provider kept
 * charging, with nothing left to reconcile against. Kept, the next delivery of
 * the leg (or the next Purge click) cancels it again. A cancel that fails
 * because the provider already ended the subscription is not a failure: the
 * provider's own view is consulted, and a `canceled` answer lets the row go.
 *
 * Idempotent: a second run over a purged org matches nothing.
 */

import { actorId as auditActorId, createLogger, errorMessage, recordAudit } from '@pipeline-builder/api-core';
import { TERMINAL_SUBSCRIPTION_STATUSES } from './subscription-status.js';
import { BillingEvent } from '../models/billing-event.js';
import { Subscription } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('billing-org-purge');

/**
 * An org realistically holds a single live subscription; the cap keeps the
 * provider-cancel loop and the audit mirror bounded against pathological data.
 */
const MAX_BILLABLE = 1000;

/** What one purge removed, and what it had to keep. */
export interface OrgBillingPurgeResult {
  /** Subscription rows removed. */
  subscriptions: number;
  /** Billing-event rows removed. */
  billingEvents: number;
  /** Subscriptions KEPT because they may still be billing at the provider (retry). */
  retained: number;
}

/**
 * Cancel at the provider, immediately; `true` when the subscription is no longer
 * billing there (cancelled now, or already ended), `false` to keep the local row.
 *
 * A provider with no immediate cancel (AWS Marketplace, where the BUYER owns the
 * agreement and the seller cannot end it; the dev stub) gets its ordinary
 * `cancelSubscription`, which on both is a logged no-op.
 */
async function cancelAtProvider(orgId: string, subscriptionId: string, externalId: string): Promise<boolean> {
  const provider = getPaymentProvider();
  try {
    if (provider.cancelSubscriptionNow) await provider.cancelSubscriptionNow(externalId);
    else await provider.cancelSubscription(externalId);
    return true;
  } catch (err) {
    // The provider may refuse because the subscription is already over (Stripe
    // rejects an update to a canceled subscription). Its own view decides; any
    // doubt keeps the row.
    try {
      const view = await provider.getSubscription?.(externalId);
      if (view?.status === 'canceled') return true;
    } catch {
      // Fall through: unknown provider state keeps the row.
    }
    logger.warn('Provider cancel failed during org purge — keeping the subscription for a retry', {
      orgId,
      subscriptionId,
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Purge `orgId`'s billing state. `actor` is who to attribute the per-subscription
 * `billing.subscription.delete` audit rows to (a user id, or the system actor for
 * the cascade). Throws only on a store failure.
 */
export async function purgeOrgBilling(orgId: string, actor: string | undefined): Promise<OrgBillingPurgeResult> {
  // Cancel every still-live subscription at the provider first so we don't
  // leave billable state running after our local rows are gone. A trialing /
  // past_due row carries a live externalId at the provider just like an active
  // one, and an `incomplete` one has an open first invoice — so the whole
  // non-terminal set is what has to be cancelled.
  const billable = await Subscription.find({
    orgId, status: { $nin: [...TERMINAL_SUBSCRIPTION_STATUSES] },
  }).limit(MAX_BILLABLE);

  // A failed cancel keeps the row (it is not pushed here).
  const removed: typeof billable = [];
  for (const sub of billable) {
    if (!sub.externalId || await cancelAtProvider(orgId, sub._id.toString(), sub.externalId)) removed.push(sub);
  }

  // Delete only rows known not to be billing: the terminal ones, and the
  // live ones cancelled above. NOT a blanket `{ orgId }` — a row created after
  // the sweep read (a checkout landing mid-purge) was never cancelled, and
  // dropping it would lose the only record of a live provider subscription. It
  // survives and is reported below.
  const subDelete = await Subscription.deleteMany({
    orgId,
    $or: [
      { status: { $in: [...TERMINAL_SUBSCRIPTION_STATUSES] } },
      { _id: { $in: removed.map((s) => s._id) } },
    ],
  });

  // Whatever is left is still live at the provider (a failed cancel, or a row
  // that went billable mid-purge): `retained`, so the caller retries.
  const survivors = (await Subscription.distinct('_id', { orgId })).map((id) => String(id));

  // Billing events are scoped to the org and have no independent purpose once
  // the subscription is gone (audit retention lives in platform's audit trail).
  // A surviving subscription keeps its own events.
  const eventDelete = await BillingEvent.deleteMany(
    survivors.length ? { orgId, subscriptionId: { $nin: survivors } } : { orgId },
  );

  // Mirror each removed billable subscription to the central audit trail.
  // Fire-and-forget; details are an id-only whitelist.
  for (const sub of removed) {
    recordAudit({
      action: 'billing.subscription.delete',
      actorId: auditActorId({ userId: actor }),
      orgId,
      targetId: sub._id.toString(),
      details: { planId: sub.planId, orgId },
    });
  }

  const result = {
    subscriptions: subDelete.deletedCount ?? 0,
    billingEvents: eventDelete.deletedCount ?? 0,
    retained: survivors.length,
  };
  logger.info('Org billing purge complete', { orgId, ...result });
  return result;
}
