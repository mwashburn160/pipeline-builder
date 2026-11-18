// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tear one org's billing state down: cancel its billable subscriptions at the
 * payment provider, then drop its subscriptions and billing events.
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
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from './subscription-status.js';
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
  /** Billable subscriptions KEPT because the provider cancel failed (retry). */
  retained: number;
}

/**
 * Cancel at the provider; `true` when the subscription is no longer billing
 * there (cancelled now, or already ended), `false` to keep the local row.
 */
async function cancelAtProvider(orgId: string, subscriptionId: string, externalId: string): Promise<boolean> {
  const provider = getPaymentProvider();
  try {
    await provider.cancelSubscription(externalId);
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
  // Cancel every still-billable subscription at the provider first so we don't
  // leave billable state running after our local rows are gone. A trialing /
  // past_due row carries a live externalId at the provider just like an active
  // one, so the manageable (non-terminal) set is what has to be cancelled.
  const billable = await Subscription.find({
    orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
  }).limit(MAX_BILLABLE);

  const kept: string[] = [];
  const removed: typeof billable = [];
  for (const sub of billable) {
    const id = sub._id.toString();
    if (sub.externalId && !(await cancelAtProvider(orgId, id, sub.externalId))) kept.push(id);
    else removed.push(sub);
  }

  const subDelete = await Subscription.deleteMany(kept.length ? { orgId, _id: { $nin: kept } } : { orgId });

  // Billing events are scoped to the org and have no independent purpose once
  // the subscription is gone (audit retention lives in platform's audit trail).
  // A KEPT subscription keeps its own events.
  const eventDelete = await BillingEvent.deleteMany(kept.length ? { orgId, subscriptionId: { $nin: kept } } : { orgId });

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
    retained: kept.length,
  };
  logger.info('Org billing purge complete', { orgId, ...result });
  return result;
}
