// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * newSubscriptionAction — the pure provider-branching used by the billing page's
 * doSubscribe for a brand-new subscription. Stripe + paid → hosted Checkout;
 * free plans and the card-less `stub` → created directly; aws-marketplace and an
 * unknown (still-loading) provider are blocked (no accidental create/charge).
 */

import { newSubscriptionAction } from '../src/components/billing/subscribe-action';

describe('newSubscriptionAction', () => {
  it('sends a paid Stripe plan through hosted Checkout', () => {
    expect(newSubscriptionAction('stripe', false)).toBe('checkout');
  });

  it('creates a FREE Stripe plan directly (no card / no Checkout)', () => {
    expect(newSubscriptionAction('stripe', true)).toBe('direct');
  });

  it('creates directly under the card-less stub provider (paid or free)', () => {
    expect(newSubscriptionAction('stub', false)).toBe('direct');
    expect(newSubscriptionAction('stub', true)).toBe('direct');
  });

  it('blocks self-serve subscribe on AWS Marketplace deployments', () => {
    expect(newSubscriptionAction('aws-marketplace', false)).toBe('blocked-marketplace');
    expect(newSubscriptionAction('aws-marketplace', true)).toBe('blocked-marketplace');
  });

  it('blocks while the provider is unknown (probe in flight) — never guesses', () => {
    expect(newSubscriptionAction(undefined, false)).toBe('blocked-loading');
    expect(newSubscriptionAction(undefined, true)).toBe('blocked-loading');
  });
});
