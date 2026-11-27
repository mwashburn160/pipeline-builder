// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { createBillingEvent } from './billing-helpers.js';
import { clawbackRecentPromotions } from './promotion-engine.js';
import { setMetadataKey } from './subscription-metadata.js';
import { Subscription, type SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('billing-provider-reconcile');

/**
 * `metadata` key stamped on a subscription whose last provider write ended with
 * an UNKNOWN outcome (timeout / connection loss / provider 5xx — see
 * `isProviderOutcomeUnknown`). The local row carries the INTENDED state; the
 * lifecycle pass reads the provider's actual state and adopts it.
 */
export const PROVIDER_RECONCILE_KEY = 'providerReconcilePending';

/** The provider writes whose unknown outcome is reconciled from the provider. */
export type ReconcileOp = 'cancel' | 'reactivate';

export interface ProviderReconcileMarker {
  op: ReconcileOp;
  /** The `cancelAtPeriodEnd` the route was trying to reach. */
  intendedCancelAtPeriodEnd: boolean;
  /** ISO timestamp; also the compare-and-set token for the reconcile write. */
  at: string;
  actorId?: string;
}

/** The marker on a row, when it carries a well-formed one. */
export function readReconcileMarker(sub: { metadata?: Record<string, unknown> }): ProviderReconcileMarker | undefined {
  const raw = sub.metadata?.[PROVIDER_RECONCILE_KEY] as Partial<ProviderReconcileMarker> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.at !== 'string') return undefined;
  if (raw.op !== 'cancel' && raw.op !== 'reactivate') return undefined;
  return raw as ProviderReconcileMarker;
}

type MutableSub = {
  metadata?: Record<string, unknown>;
  save: () => Promise<unknown>;
};

/**
 * Record that a provider write's outcome is unknown, keeping the local INTENDED
 * state (not reverting it) so the next lifecycle tick can settle it against the
 * provider. Never throws: the route is already answering 503, and a failed stamp
 * is logged + counted (the stale-active pass still re-verifies at period end).
 */
export async function markProviderReconcilePending(
  subscription: MutableSub,
  op: ReconcileOp,
  intendedCancelAtPeriodEnd: boolean,
  cause: unknown,
  actorId?: string,
): Promise<void> {
  const marker: ProviderReconcileMarker = { op, intendedCancelAtPeriodEnd, at: new Date().toISOString(), ...(actorId ? { actorId } : {}) };
  incCounter('billing_provider_outcome_unknown_total', { op });
  logger.error('Provider write outcome unknown — keeping local intent and marking for reconcile', {
    op, intendedCancelAtPeriodEnd, error: errorMessage(cause),
  });
  try {
    // One path, not the whole object (see helpers/subscription-metadata.ts).
    setMetadataKey(subscription, PROVIDER_RECONCILE_KEY, marker);
    await subscription.save();
  } catch (err) {
    incCounter('billing_provider_reconcile_total', { outcome: 'mark_failed' });
    logger.error('Failed to stamp provider-reconcile marker', { op, error: errorMessage(err) });
  }
}

/**
 * Drop the marker after a later provider write CONFIRMED the state (a retried
 * cancel/reactivate that succeeded). Best effort: a leftover marker only makes
 * the reconcile pass re-read the provider and adopt the same value.
 */
export async function clearProviderReconcilePending(subscription: MutableSub): Promise<void> {
  if (!subscription.metadata || !(PROVIDER_RECONCILE_KEY in subscription.metadata)) return;
  try {
    setMetadataKey(subscription, PROVIDER_RECONCILE_KEY, undefined);
    await subscription.save();
  } catch (err) {
    logger.warn('Failed to clear provider-reconcile marker (next reconcile pass will)', { error: errorMessage(err) });
  }
}

/**
 * Settle every subscription whose last cancel/reactivate ended with an unknown
 * provider outcome: read the provider's real `cancelAtPeriodEnd` via
 * `getSubscription` and adopt it. When the provider confirms the INTENDED state
 * the side effects the route skipped (billing event, cancel-time promotion
 * clawback) run now; when it shows the write never landed the local row is put
 * back to the provider's value. A provider read failure leaves the marker for
 * the next tick. Iterates a cursor so the pass is bounded in memory.
 */
export async function reconcileUnknownProviderOutcomes(): Promise<void> {
  const provider = getPaymentProvider();
  const cursor = Subscription.find({ [`metadata.${PROVIDER_RECONCILE_KEY}`]: { $exists: true } }).cursor();
  for await (const subscription of cursor as AsyncIterable<SubscriptionDocument>) {
    const marker = readReconcileMarker(subscription);
    const subscriptionId = subscription._id.toString();
    try {
      if (!marker) {
        await clearMarker(subscription, undefined);
        incCounter('billing_provider_reconcile_total', { outcome: 'malformed' });
        continue;
      }
      if (!provider.getSubscription || !subscription.externalId) {
        // Nothing to read the truth from: keep the local intent (the stale-active
        // pass still verifies at period end) and stop re-visiting the row.
        await clearMarker(subscription, marker);
        incCounter('billing_provider_reconcile_total', { outcome: 'unsupported' });
        continue;
      }
      const view = await provider.getSubscription(subscription.externalId);
      if (!view || typeof view.cancelAtPeriodEnd !== 'boolean') {
        // A deleted/terminal sub (or a provider that doesn't report the flag) is
        // owned by the stale-active pass; this marker has nothing left to settle.
        await clearMarker(subscription, marker);
        incCounter('billing_provider_reconcile_total', { outcome: 'no_flag' });
        continue;
      }
      const landed = view.cancelAtPeriodEnd === marker.intendedCancelAtPeriodEnd;
      const res = await Subscription.updateOne(
        { _id: subscription._id, [`metadata.${PROVIDER_RECONCILE_KEY}.at`]: marker.at },
        { $set: { cancelAtPeriodEnd: view.cancelAtPeriodEnd }, $unset: { [`metadata.${PROVIDER_RECONCILE_KEY}`]: '' } },
      );
      // Lost the compare-and-set: a newer route write owns the row now.
      if (!res.modifiedCount) continue;
      incCounter('billing_provider_reconcile_total', { outcome: landed ? 'confirmed' : 'reverted' });
      logger.info('Reconciled unknown provider outcome', {
        orgId: subscription.orgId, subscriptionId, op: marker.op, landed, cancelAtPeriodEnd: view.cancelAtPeriodEnd,
      });
      if (!landed) continue;
      if (marker.op === 'cancel') {
        await createBillingEvent(subscription.orgId, 'subscription_canceled', {
          planId: subscription.planId,
          cancelAtPeriodEnd: true,
          periodEnd: subscription.currentPeriodEnd.toISOString(),
          reconciled: true,
        }, subscriptionId, marker.actorId);
        await clawbackRecentPromotions(subscription, marker.actorId).catch((err: unknown) => {
          logger.error('Promotion clawback failed on reconciled cancel', { orgId: subscription.orgId, error: errorMessage(err) });
        });
      } else {
        await createBillingEvent(subscription.orgId, 'subscription_reactivated', {
          planId: subscription.planId,
          reconciled: true,
        }, subscriptionId, marker.actorId);
      }
    } catch (err) {
      incCounter('billing_provider_reconcile_total', { outcome: 'provider_error' });
      logger.warn('Provider reconcile read failed — retrying next tick', {
        orgId: subscription.orgId, subscriptionId, error: errorMessage(err),
      });
    }
  }
}

async function clearMarker(subscription: SubscriptionDocument, marker: ProviderReconcileMarker | undefined): Promise<void> {
  await Subscription.updateOne(
    marker
      ? { _id: subscription._id, [`metadata.${PROVIDER_RECONCILE_KEY}.at`]: marker.at }
      : { _id: subscription._id },
    { $unset: { [`metadata.${PROVIDER_RECONCILE_KEY}`]: '' } },
  );
}
