// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Calendar billing-period key for per-period idempotency of recurring credits.
 *
 * `YYYY` for annual, `YYYY-MM` for monthly. Single source of truth so the Stripe
 * invoice reconciler, the Marketplace metering cycle, and the promotion engine
 * all scope a "re-grant once per period" the SAME way — keying on this instead of
 * a Stripe invoice id is what stops a second invoice in the same period (a
 * proration / one-off) from injecting a duplicate credit.
 */
export function billingPeriodKey(interval: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  return interval === 'annual' ? String(y) : `${y}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
