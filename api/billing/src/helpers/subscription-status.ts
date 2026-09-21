// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Subscription } from '../models/subscription.js';
import type { SubscriptionDocument } from '../models/subscription.js';

/**
 * Subscription statuses an org can still MANAGE (change plan, buy add-ons,
 * redeem discounts). Single source of truth — imported by billing-helpers,
 * discount-helpers, and promotion-engine so the three can't drift (they
 * previously each kept their own copy, e.g. if `past_due` handling changed).
 *
 * This is a deliberately LEAF module (only the Subscription model) so the
 * heavy-import-averse consumers can pull it without dragging in billing-helpers.
 */
export const MANAGEABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/** The org's current manageable subscription, if any. */
export async function loadManageableSubscription(orgId: string): Promise<SubscriptionDocument | null> {
  return Subscription.findOne({ orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } });
}

/**
 * Has this subscription already LOST its entitlements because the dunning grace
 * period lapsed?
 *
 * `past_due` is manageable and, for most of its life, still entitled — that is
 * the whole point of a grace window. Once `expireGracePeriods` runs, though, the
 * org has been synced down to `developer` with no add-ons, and the row is
 * stamped `metadata.gracePeriodDowngradedAt`. The STATUS does not change (it
 * stays `past_due` until the customer pays or cancels), so status alone cannot
 * tell the two halves of `past_due` apart — this marker is the only signal.
 *
 * Anything that re-pushes entitlements must consult this, or it hands the paid
 * tier back to an account that stopped paying. `handlePaymentSucceeded` clears
 * the marker on recovery, so this reverts to false the moment they pay.
 */
export function isGraceDowngraded(subscription: { metadata?: Record<string, unknown> | null }): boolean {
  return !!subscription.metadata?.gracePeriodDowngradedAt;
}
