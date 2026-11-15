// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The provider side of a usage-credit clawback: the `pendingCreditDebits`
 * outbox on a subscription, drained to the payment provider.
 *
 * A clawback reduces the local credit mirror and queues the matching provider
 * debit in the SAME write (see `clawbackRecentPromotions`). This module posts a
 * queued debit and removes it once the provider accepted it; a failure leaves
 * it queued for the lifecycle reconciler, which re-posts it under the same
 * idempotency key — the same marker-and-reconciler shape the provider add-on
 * sync uses, so a transient provider outage delays a debit but never loses it.
 */

import { createLogger, emitCounter, errorMessage } from '@pipeline-builder/api-core';
import { Subscription, type SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('credit-debits');

/**
 * Post one owed debit to the provider and, once it is accepted, drop it from
 * the subscription's `pendingCreditDebits` outbox. A failure leaves the entry in
 * place for {@link retryPendingCreditDebits} and counts
 * `billing_promotion_clawback_debit_failed_total`. Never throws: the local
 * clawback has already committed, and the outbox is what carries it to the
 * provider.
 */
export async function postPendingCreditDebit(
  subscription: Pick<SubscriptionDocument, '_id' | 'orgId' | 'externalCustomerId'>,
  debit: { key: string; cents: number },
  source: 'clawback' | 'retry',
): Promise<boolean> {
  const provider = getPaymentProvider();
  try {
    if (provider.debitUsageCredit && subscription.externalCustomerId) {
      await provider.debitUsageCredit(subscription.externalCustomerId, debit.cents, debit.key);
    }
    // No debit capability, or no provider customer: there is no provider-held
    // credit to take back (the local mirror is the whole of it), so the debit is
    // settled by the local clawback alone.
    await Subscription.updateOne({ _id: subscription._id }, { $pull: { pendingCreditDebits: { key: debit.key } } });
    return true;
  } catch (err) {
    emitCounter('billing_promotion_clawback_debit_failed_total', { source });
    logger.error('Provider debit of clawed-back credit failed — kept for retry', {
      orgId: subscription.orgId, key: debit.key, cents: debit.cents, source, error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Re-drive every provider debit a clawback still owes on this subscription —
 * run by the lifecycle reconciler. Same key per debit as the first attempt, so
 * the provider dedupes an attempt that landed but whose acknowledgement was
 * lost. (Stripe keeps an idempotency record for 24 hours; the reconciler's
 * cadence re-drives well inside that, so only a lost acknowledgement followed by
 * a day-long provider outage could post one twice.) Returns how many settled.
 */
export async function retryPendingCreditDebits(
  subscription: Pick<SubscriptionDocument, '_id' | 'orgId' | 'externalCustomerId' | 'pendingCreditDebits'>,
): Promise<number> {
  let settled = 0;
  for (const debit of subscription.pendingCreditDebits ?? []) {
    if (await postPendingCreditDebit(subscription, debit, 'retry')) settled += 1;
  }
  return settled;
}
