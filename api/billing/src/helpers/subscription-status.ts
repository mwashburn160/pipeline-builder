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
