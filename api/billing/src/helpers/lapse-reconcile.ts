// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "the sub is entitled again, so it is no longer grace-lapsed" reconcile.
 *
 * The lifecycle cron stamps `metadata.gracePeriodDowngradedAt` when a `past_due`
 * sub's grace window expires and downgrades the org to developer. While that
 * marker is set, every entitlement re-push ({@link isGraceDowngraded}) resolves
 * the org to developer. So whichever Stripe event first observes the sub back in
 * an entitled status (`active` / `trialing`) must clear it AND re-push the paid
 * tier — not only `invoice.payment_succeeded` from `past_due`. Stripe does not
 * order `customer.subscription.updated` against `invoice.*`, and when the
 * `.updated`→active lands first the invoice handler sees `previousStatus ===
 * 'active'`, so before this helper the marker was never cleared and the org
 * stayed on developer for good.
 *
 * Two phases, because entitlement pushes always run AFTER the row is saved:
 * {@link prepareLapseReconcile} mutates the in-memory doc (persisted by the
 * caller's save) and returns the post-save re-sync, or null when nothing to do.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { recordReactivatePlanMissing } from './billing-helpers.js';
import { syncEntitlements } from './entitlement-sync.js';
import { setMetadataKey } from './subscription-metadata.js';
import { isGraceDowngraded } from './subscription-status.js';
import { Plan } from '../models/plan.js';
import type { SubscriptionDocument } from '../models/subscription.js';

const logger = createLogger('billing-lapse-reconcile');

const ENTITLED_STATUSES: readonly string[] = ['active', 'trialing'];

type LapseSubscription = Pick<SubscriptionDocument, '_id' | 'orgId' | 'planId' | 'status' | 'addons' | 'metadata'>;

/**
 * If `subscription` (as the caller is about to save it) is in an entitled status
 * but still carries the grace-lapse marker, drop the marker from its in-memory
 * metadata and return the post-save entitlement re-sync. Returns null otherwise.
 *
 * The caller MUST save the row before running the returned function, and may
 * skip running it when another step in the same handler already re-pushes the
 * tier (a plan change / became-entitled grant / payment recovery).
 */
export function prepareLapseReconcile(
  subscription: LapseSubscription,
  source: string,
): (() => Promise<void>) | null {
  if (!ENTITLED_STATUSES.includes(subscription.status)) return null;
  if (!isGraceDowngraded(subscription)) return null;

  const cleared = subscription.metadata?.gracePeriodDowngradedAt;
  // ONE path, not the whole object: see helpers/subscription-metadata.ts.
  setMetadataKey(subscription, 'gracePeriodDowngradedAt', undefined);
  const subscriptionId = subscription._id.toString();
  logger.info('Entitled subscription still carried the grace-lapse marker — clearing and re-granting tier', {
    orgId: subscription.orgId, subscriptionId, status: subscription.status, lapsedAt: cleared, source,
  });

  return async () => {
    const plan = await Plan.findById(subscription.planId);
    if (!plan) {
      logger.warn('Lapse reconcile could not re-grant — subscription plan not found', {
        orgId: subscription.orgId, subscriptionId, planId: subscription.planId,
      });
      await recordReactivatePlanMissing(subscription.orgId, subscriptionId, 'stripe_webhook', {
        provider: 'stripe', planId: subscription.planId, source,
      });
      return;
    }
    await syncEntitlements(subscription.orgId, plan.tier, '', subscriptionId, subscription.addons ?? []);
  };
}
