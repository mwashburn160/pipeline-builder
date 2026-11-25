// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The billing currency (`BILLING_CURRENCY`, default `usd`), lower-case ISO 4217.
 *
 * Every price this service authors — plans, add-ons, combos, discounts,
 * promotions — is in this one currency, and every response carrying such an
 * amount names it, so a client never assumes dollars. `config.currency` /
 * `config.stripe.currency` read this same constant, so what a customer is shown
 * and what Stripe is sent cannot drift.
 *
 * Its own module, read straight from the env, so route modules can import it
 * without pulling in `../config.js` (which validates the whole environment at
 * import and throws without `MONGODB_URI`).
 */
export const BILLING_CURRENCY: string = (process.env.BILLING_CURRENCY || 'usd').trim().toLowerCase() || 'usd';
