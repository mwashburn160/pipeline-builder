// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure add-on catalog math for the add-on routes: apply/cascade a bundle change,
 * the purchasability / quantity-cap / `requires` gates, and the itemized price +
 * combo-discount projections. No I/O — the routes own loading, the guarded
 * commit, and the entitlement/provider sync.
 */

import { FEATURE_METADATA, TIER_FEATURES, isValidFeatureFlag, type QuotaTier } from '@pipeline-builder/api-core';
import type { BundleConfig, ComboDiscountConfig } from '../config/billing-types.js';
import { activeComboCredits, comboBasisCents, getComboDiscounts, volumeCredits } from './combo-pricing.js';

export type Addon = { bundleId: string; quantity: number };

/** Set a bundle's quantity in the add-on list (quantity 0 removes it). */
export function applyAddon(addons: Addon[], bundleId: string, quantity: number): Addon[] {
  const rest = addons.filter((a) => a.bundleId !== bundleId);
  if (quantity > 0) rest.push({ bundleId, quantity });
  return rest;
}

/**
 * Resolve an active bundle that is purchasable on `tier`, or an error message.
 * Shared by the preview + add handlers so the "unknown bundle" / "not available
 * on this plan" gate (and its 400 copy) can't drift between them.
 */
export function resolvePurchasableBundle(
  bundles: readonly BundleConfig[],
  bundleId: string,
  tier: QuotaTier,
): { bundle: BundleConfig } | { error: string } {
  const bundle = bundles.find((b) => b.id === bundleId && b.isActive);
  if (!bundle) return { error: `Unknown bundle "${bundleId}"` };
  if (!bundle.availableForTiers.includes(tier)) {
    return { error: `Bundle "${bundleId}" is not available on the ${tier} plan` };
  }
  return { bundle };
}

/** The over-`maxQuantity` (retention-ceiling) 400 message for a stacked bundle,
 *  or null when within cap. Shared so the preview + add gate stay identical. */
export function bundleQuantityCapError(bundle: BundleConfig, qty: number): string | null {
  return bundle.maxQuantity !== undefined && qty > bundle.maxQuantity
    ? `Bundle "${bundle.id}" is capped at ${bundle.maxQuantity} (retention ceiling)`
    : null;
}

/** The set of bundle ids HELD (quantity > 0) in an add-on list. */
function heldBundleIds(addons: readonly Addon[]): Set<string> {
  return new Set(addons.filter((a) => a.quantity > 0).map((a) => a.bundleId));
}

/**
 * The feature flags an account holds with `addons` on `tier`: the tier's own
 * (`TIER_FEATURES`) plus every flag a held bundle grants — the same union
 * `syncEntitlements` pushes to the platform.
 */
function effectiveFeatureSet(tier: QuotaTier, addons: readonly Addon[], bundles: readonly BundleConfig[]): Set<string> {
  const held = heldBundleIds(addons);
  const features = new Set<string>(TIER_FEATURES[tier] ?? []);
  for (const b of bundles) {
    if (held.has(b.id)) for (const f of b.features ?? []) features.add(f);
  }
  return features;
}

/** Human label for a feature flag (raw flag when it isn't a known one). */
function featureLabel(flag: string): string {
  return isValidFeatureFlag(flag) ? FEATURE_METADATA[flag].label : flag;
}

/** Prerequisites a bundle is missing — see {@link bundleUnmetRequirement}. */
export interface UnmetRequirement {
  /** `requires` bundle ids not held in the set. */
  bundleIds: string[];
  /** `requiresFeatures` flags neither tier-included nor granted by a held bundle. */
  features: string[];
  /** The customer-facing 400 copy. */
  message: string;
}

/**
 * Generic prerequisite gate: what `bundle` is missing when evaluated against the
 * add-on set `next` (the set AFTER the change) on `tier`, or null when satisfied /
 * no prerequisites. Two kinds, both generic (not compliance- or DORA-specific):
 *
 *  - `requires` (bundle ids) — satisfied when the prerequisite is present in
 *    `next`, whether already held or added in the same action. E.g.
 *    `compliance_advanced` → `compliance_standard`.
 *  - `requiresFeatures` (feature flags) — satisfied when the tier includes the
 *    flag OR a bundle held in `next` grants it. E.g. `dora_history_pack` →
 *    `advanced_reporting` (tier-included on Enterprise, an add-on below it).
 *
 * Only enforced when `bundle` itself is held after the change (qty > 0).
 */
export function bundleUnmetRequirement(
  bundle: BundleConfig,
  next: readonly Addon[],
  bundles: readonly BundleConfig[],
  tier: QuotaTier,
): UnmetRequirement | null {
  const requires = bundle.requires ?? [];
  const requiresFeatures = bundle.requiresFeatures ?? [];
  if (requires.length === 0 && requiresFeatures.length === 0) return null;
  const held = heldBundleIds(next);
  if (!held.has(bundle.id)) return null; // bundle isn't being added/kept — nothing to gate
  const bundleIds = requires.filter((r) => !held.has(r));
  const featureSet = requiresFeatures.length > 0 ? effectiveFeatureSet(tier, next, bundles) : new Set<string>();
  const features = requiresFeatures.filter((f) => !featureSet.has(f));
  if (bundleIds.length === 0 && features.length === 0) return null;

  const byId = new Map(bundles.map((b) => [b.id, b]));
  const parts: string[] = [];
  if (bundleIds.length > 0) parts.push(`the ${bundleIds.map((r) => byId.get(r)?.name ?? r).join(', ')} add-on`);
  if (features.length > 0) parts.push(`${features.map(featureLabel).join(', ')}, which your plan doesn't include yet`);
  return { bundleIds, features, message: `${bundle.name} requires ${parts.join(' and ')}` };
}

/** The 400 message for {@link bundleUnmetRequirement}, or null when satisfied. */
export function bundleRequiresError(
  bundle: BundleConfig,
  next: readonly Addon[],
  bundles: readonly BundleConfig[],
  tier: QuotaTier,
): string | null {
  return bundleUnmetRequirement(bundle, next, bundles, tier)?.message ?? null;
}

/**
 * Cascade-remove: after a bundle is removed (or the tier changes), any OTHER held
 * bundle whose prerequisites — `requires[]` bundles or `requiresFeatures[]` flags
 * on `tier` — are no longer satisfied by the remaining set must go too (a
 * dependent can't outlive its prerequisite). Iterated to a fixpoint so a chain
 * (A requires B requires C; remove C ⇒ drop B then A) fully unwinds. Returns the
 * reduced add-on list plus the ids that were cascaded (for audit). Generic on the
 * prerequisite fields — not compliance- or DORA-specific.
 */
export function cascadeRemoveDependents(
  next: readonly Addon[],
  bundles: readonly BundleConfig[],
  tier: QuotaTier,
): { addons: Addon[]; removed: string[] } {
  const byId = new Map(bundles.map((b) => [b.id, b]));
  let addons: Addon[] = [...next];
  const removed: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of addons) {
      if (a.quantity <= 0) continue;
      const bundle = byId.get(a.bundleId);
      if (bundle && bundleUnmetRequirement(bundle, addons, bundles, tier)) {
        addons = applyAddon(addons, a.bundleId, 0);
        removed.push(a.bundleId);
        changed = true;
        break;
      }
    }
  }
  return { addons, removed };
}

/** Catalog-time combo savings (`min-composition basket − combined price`, ≥ 0) for
 *  an interval — ownership-independent, for the "pair to save" nudge. Shares
 *  `comboBasisCents` with the credit math so the two can't drift. */
export function comboSavings(combo: ComboDiscountConfig, bundles: readonly BundleConfig[], interval: 'monthly' | 'annual'): number {
  return Math.max(0, comboBasisCents(combo, bundles, interval) - combo.prices[interval]);
}

/**
 * Itemized price breakdown: base plan line + one line per add-on, then a NEGATIVE
 * line per active combo discount (e.g. Analytics Suite −$20/mo when both DORA and
 * Team Usage Analytics are held). The combo credit is realized as a recurring
 * usage credit at invoice time; this line shows the customer the net up front so
 * `totalCents` matches what they'll effectively pay.
 */
export function priceBreakdown(
  plan: { name: string; prices: { monthly: number; annual: number } },
  addons: Addon[],
  bundles: readonly BundleConfig[],
  interval: 'monthly' | 'annual',
): { interval: string; items: { label: string; quantity: number; cents: number }[]; totalCents: number } {
  const key = interval === 'annual' ? 'annual' : 'monthly';
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const items = [{ label: plan.name, quantity: 1, cents: plan.prices[key] }];
  for (const a of addons) {
    const b = byId.get(a.bundleId);
    if (b) items.push({ label: b.name, quantity: a.quantity, cents: b.prices[key] * a.quantity });
  }
  // Volume-discount lines (e.g. per-seat tiers) — negative, like combo credits. The
  // pack line above stays full unit×qty; this line shows the discount so the net
  // `totalCents` is what the customer effectively pays (realized as a usage credit).
  for (const v of volumeCredits(addons, bundles, interval)) {
    items.push({ label: `${v.name} volume discount`, quantity: 1, cents: -v.creditCents });
  }
  for (const combo of activeComboCredits(addons, bundles, getComboDiscounts(), interval)) {
    items.push({ label: `${combo.name} discount`, quantity: 1, cents: -combo.creditCents });
  }
  return { interval, items, totalCents: items.reduce((s, i) => s + i.cents, 0) };
}

/** A combo gained/lost by a proposed add-on change (drives the removal warning + the
 *  `combo_expired` event). */
export type ComboChange = { comboId: string; name: string; creditCents: number };

/**
 * The combo discounts LOST and GAINED moving from `current` → `next` add-ons. Diffed
 * on the packed active set (so it reflects real max-weight packing, not raw membership).
 */
export function comboDelta(
  current: Addon[],
  next: Addon[],
  bundles: readonly BundleConfig[],
  interval: 'monthly' | 'annual',
): { lostCombos: ComboChange[]; gainedCombos: ComboChange[] } {
  const combos = getComboDiscounts();
  const before = activeComboCredits(current, bundles, combos, interval);
  const after = activeComboCredits(next, bundles, combos, interval);
  const afterIds = new Set(after.map((c) => c.comboId));
  const beforeIds = new Set(before.map((c) => c.comboId));
  return {
    lostCombos: before.filter((c) => !afterIds.has(c.comboId)),
    gainedCombos: after.filter((c) => !beforeIds.has(c.comboId)),
  };
}
