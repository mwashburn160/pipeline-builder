// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every subscription status the billing service reports, keyed by its wire id
 * (api-core's `SUBSCRIPTION_STATUSES`): the label people read and the badge
 * colour it carries. Keyed by the union so a status added there is a compile
 * error here, and every surface — the tenant's status card, the admin fleet
 * table, its filter chips and override picker — names and colours it the same.
 */

import type { BadgeColor } from '@/components/ui/Badge';
import type { SubscriptionStatus } from '@/types';

export const SUBSCRIPTION_STATUS_META = {
  active: { label: 'Active', color: 'green' },
  trialing: { label: 'Trialing', color: 'blue' },
  past_due: { label: 'Past due', color: 'yellow' },
  incomplete: { label: 'Incomplete', color: 'red' },
  canceled: { label: 'Canceled', color: 'gray' },
} as const satisfies Record<SubscriptionStatus, { label: string; color: BadgeColor }>;

/** Every status, in display order. */
export const SUBSCRIPTION_STATUS_IDS = Object.keys(SUBSCRIPTION_STATUS_META) as SubscriptionStatus[];

/** A status off the wire as people read it; an unknown one is shown raw. */
export function subscriptionStatusLabel(status: string): string {
  return Object.hasOwn(SUBSCRIPTION_STATUS_META, status)
    ? SUBSCRIPTION_STATUS_META[status as SubscriptionStatus].label
    : status;
}

/** The badge colour for a status off the wire; an unknown one is red (it needs a look). */
export function subscriptionStatusColor(status: string): BadgeColor {
  return Object.hasOwn(SUBSCRIPTION_STATUS_META, status)
    ? SUBSCRIPTION_STATUS_META[status as SubscriptionStatus].color
    : 'red';
}
