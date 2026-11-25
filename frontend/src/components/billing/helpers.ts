// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatCents } from '@/lib/format';

/** Default plan/tier id used as the pre-selected option on signup + onboarding. */
export const DEFAULT_PLAN_ID = 'developer';

/**
 * Formats a price in cents of `currency` (the lower-case ISO code the billing
 * response names) as a display string. `0` renders as "Free"; pass
 * `{ suffix: '/mo' }` for the per-month form used on the pickers.
 */
export function formatPrice(cents: number, currency: string, opts?: { suffix?: string }): string {
  if (cents === 0) return 'Free';
  return `${formatCents(cents, currency)}${opts?.suffix ?? ''}`;
}
