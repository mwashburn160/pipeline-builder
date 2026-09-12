// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which plans an add-on pack is sold on.
 *
 * The bundles endpoint filters the catalog to the account's tier once
 * subscribed, but returns EVERYTHING when there's no subscription to read a tier
 * from. So the unsubscribed preview lists packs that a given plan may not sell
 * (Member Seat is Team+, Audit Log and SSO are Pro-only) — these helpers surface
 * that on the card and in the plan-picker prompt, instead of letting the pack
 * quietly vanish after the buyer picks a plan.
 */

import { TIER_KEYS, TIER_META, type TierKey } from '@/lib/tiers';
import type { Bundle } from '@/types';

/** The purchasable tiers a pack is sold on, lowest first (`unlimited` is never sold). */
export function sellableTiers(bundle: Bundle): TierKey[] {
  return (bundle.availableForTiers ?? [])
    .filter((t): t is TierKey => TIER_KEYS.includes(t as TierKey))
    .sort((a, b) => TIER_META[a].sort - TIER_META[b].sort);
}

/** Plan labels for a pack: "Team and Enterprise", "every plan", or null if unknown. */
export function tierAvailabilityText(bundle: Bundle): string | null {
  const tiers = sellableTiers(bundle);
  if (tiers.length === 0) return null;
  if (tiers.length >= TIER_KEYS.length) return 'every plan';
  const labels = tiers.map((t) => TIER_META[t].label);
  return labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Card-sized version of {@link tierAvailabilityText} — "On Team and Enterprise". */
export function tierAvailabilityLabel(bundle: Bundle): string | null {
  const text = tierAvailabilityText(bundle);
  return text ? `On ${text}` : null;
}
