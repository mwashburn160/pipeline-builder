// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a limit COSTS — the cheapest pack that raises a given quota
 * (docs/plans/sales-agent.md, F2).
 *
 * "The moment someone opens a quota card at 90% is the best sales moment the
 * product has, and the card currently says only that they are about to run
 * out." This is the arithmetic behind saying the price instead.
 *
 * INFORMATION, not an offer: no agent, no campaign, no discount and no consent,
 * because it states a catalogue price rather than soliciting. The precedent is
 * `AIQuotaHint`, which already says the cost of an AI call up front instead of
 * letting it be discovered as a refusal.
 */

import { quotaPackUnit } from '@pipeline-builder/api-core/quota-catalog';
import type { Bundle, BillingInterval, DisplayedQuotaType, QuotaTier } from '@/types';

export interface QuotaPackOffer {
  bundleId: string;
  name: string;
  /** Units of this quota one pack adds, in the quota's own raw unit. */
  grantRaw: number;
  /** The same figure in the unit a person reads (GB rather than bytes). */
  grantDisplay: number;
  /** The pack unit's name, when the quota has one (`GB`, `credits`). */
  unitName: string | null;
  priceCents: number;
  interval: BillingInterval;
}

/**
 * The cheapest pack that raises `type` for an account on `tier`.
 *
 * Cheapest rather than largest, deliberately: the card is answering "what would
 * it cost to not run out", and the smallest honest answer is the one that makes
 * the sentence useful. An account that wants more buys more of the same pack.
 *
 * Returns null when nothing in the catalogue grants this dimension, when no such
 * pack is sold to this tier, or when the pack is free — quoting "$0" reads as a
 * bug rather than as a bargain. `availableForTiers` is respected so the card
 * never prices something the account cannot actually buy.
 */
export function packForQuota(
  type: DisplayedQuotaType,
  bundles: readonly Bundle[],
  interval: BillingInterval,
  tier?: QuotaTier,
): QuotaPackOffer | null {
  const unit = quotaPackUnit(type);
  const candidates = bundles.filter((b) => {
    const grant = b.grants?.[type];
    if (!grant || grant <= 0) return false;
    // A feature bundle that happens to carry a grant is not "a pack of N".
    if (!b.stackable) return false;
    if (tier && !b.availableForTiers.includes(tier)) return false;
    return priceFor(b, interval) > 0;
  });
  if (candidates.length === 0) return null;

  const cheapest = candidates.reduce((best, b) =>
    (priceFor(b, interval) < priceFor(best, interval) ? b : best));
  const grantRaw = cheapest.grants[type]!;
  return {
    bundleId: cheapest.id,
    name: cheapest.name,
    grantRaw,
    grantDisplay: unit ? grantRaw / unit.per : grantRaw,
    unitName: unit?.name ?? null,
    priceCents: priceFor(cheapest, interval),
    interval,
  };
}

function priceFor(b: Bundle, interval: BillingInterval): number {
  return interval === 'annual' ? b.prices.annual : b.prices.monthly;
}
