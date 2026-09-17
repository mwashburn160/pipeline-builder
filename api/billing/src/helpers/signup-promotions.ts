// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { evaluatePromotions, processReferralSignup } from './promotion-engine.js';
import { Subscription, type SubscriptionDocument } from '../models/subscription.js';

const logger = createLogger('billing-signup-promotions');

/**
 * Signup credit for a subscription that has just become ENTITLEMENT-WORTHY
 * (active/trialing): auto-grant `subscription_created` promotions and, when a
 * referral code rode along, credit the referee + record the pending referral.
 *
 * The single copy shared by every "a paid signup landed" path — the in-app create
 * (`POST /subscriptions`), Checkout provisioning (`customer.subscription.created`)
 * and the settle-later path (`customer.subscription.updated` incomplete→active) —
 * so the three can't drift. Callers MUST only invoke it for an entitlement-worthy
 * status: an `incomplete` sub hasn't paid and may be deleted by the provider with
 * no clawback path. Post-save + FAIL-SOFT (the engine writes atomically; an error
 * is logged, never thrown, so a promo hiccup can't fail the signup/webhook).
 */
export async function runSignupPromotions(
  subscription: SubscriptionDocument,
  plan: { tier: string; prices: { monthly: number; annual: number } },
  opts: { source: string; referralCode?: string; actorId?: string },
): Promise<void> {
  const orgId = subscription.orgId;
  const interval: 'monthly' | 'annual' = subscription.interval === 'annual' ? 'annual' : 'monthly';
  const ctx = { tier: plan.tier, interval, planPriceCents: plan.prices?.[interval] ?? 0 };

  try {
    const isFirstSubscription = (await Subscription.countDocuments({ orgId })) <= 1;
    await evaluatePromotions(orgId, subscription, 'subscription_created', { ...ctx, isFirstSubscription, actorId: opts.actorId });
  } catch (err) {
    logger.error('Promotion evaluation failed (subscription_created)', { orgId, source: opts.source, error: errorMessage(err) });
  }

  const referralCode = opts.referralCode?.trim();
  if (referralCode) {
    try {
      await processReferralSignup(orgId, referralCode, ctx);
    } catch (err) {
      logger.error('Referral processing failed (subscription_created)', { orgId, source: opts.source, error: errorMessage(err) });
    }
  }
}
