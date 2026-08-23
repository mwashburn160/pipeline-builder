// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatCents } from '@/lib/format';

/** Default plan/tier id used as the pre-selected option on signup + onboarding. */
export const DEFAULT_PLAN_ID = 'developer';

/**
 * Formats a plan price in cents as a display string. `0` renders as "Free";
 * pass `{ suffix: '/mo' }` for the per-month form used on the pickers.
 */
export function formatPrice(cents: number, opts?: { suffix?: string }): string {
  if (cents === 0) return 'Free';
  return `${formatCents(cents)}${opts?.suffix ?? ''}`;
}

/**
 * Formats an ISO date string as a human-readable date.
 * @param iso - ISO 8601 date string.
 * @returns Localized date string, e.g. "February 25, 2026".
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}
