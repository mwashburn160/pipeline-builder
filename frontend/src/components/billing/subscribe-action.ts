// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BillingProvider } from '@/hooks/useBillingEnabled';

/** The action a brand-new subscription should take, decided purely by the
 *  deployment's payment provider and whether the chosen plan is free. */
export type SubscribeAction =
  /** Stripe + a paid plan → hosted Checkout collects a card, then the webhook
   *  provisions the local subscription. */
  | 'checkout'
  /** Free plan or the card-less `stub` provider → create the subscription directly. */
  | 'direct'
  /** Provider not known yet (probe in flight/failed) — don't act; ask to retry. */
  | 'blocked-loading'
  /** AWS Marketplace deployments manage plans in the Marketplace, not in-app. */
  | 'blocked-marketplace';

/**
 * Decide how to start a NEW subscription (no existing subscription) from the
 * deployment's billing provider + whether the plan is free. Pure + exported so the
 * branching is unit-testable without rendering the billing page. Order matters:
 * an unknown provider blocks first (never guess), then marketplace is redirected
 * out, then Stripe's paid plans go through hosted Checkout, and everything else
 * (free plans, the `stub` provider) is created directly with no card.
 */
export function newSubscriptionAction(provider: BillingProvider | undefined, isFree: boolean): SubscribeAction {
  if (provider === undefined) return 'blocked-loading';
  if (provider === 'aws-marketplace') return 'blocked-marketplace';
  if (provider === 'stripe' && !isFree) return 'checkout';
  return 'direct';
}
