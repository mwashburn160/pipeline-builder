// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { getBillingConfig } from '../config/billing-config.js';
import type { BundleConfig, ComboDiscountConfig } from '../config/billing-types.js';
import type { BillingInterval } from '../models/subscription.js';

const logger = createLogger('combo-pricing');

/** Above this many satisfied combos the exact packing search falls back to greedy
 *  (guards against a pathological config; the real catalog is a handful). */
const EXACT_PACKING_CAP = 16;

/** The active combo-discount catalog (env-driven billing config). */
export function getComboDiscounts(): readonly ComboDiscountConfig[] {
  return getBillingConfig().comboDiscounts.filter((c) => c.isActive);
}

/**
 * A combo whose member bundles are all present (each at ≥ its minimum quantity),
 * plus the per-period usage credit it earns.
 */
export interface ActiveComboCredit {
  comboId: string;
  name: string;
  /** `Σ member unit price × minQty − combined price` for the interval, clamped ≥ 0. */
  creditCents: number;
}

/** A combo member's minimum required quantity (default 1 — a boolean feature bundle). */
function minQty(combo: ComboDiscountConfig, bundleId: string): number {
  return combo.minQuantities?.[bundleId] ?? 1;
}

/**
 * The volume-discount percent that applies to `quantity` units of `bundle` — the
 * highest `volumeTiers` entry whose `minQuantity ≤ quantity`, else 0. Config sorts
 * tiers ascending, so we scan for the last one that qualifies.
 */
export function volumeDiscountPct(bundle: BundleConfig, quantity: number): number {
  if (!bundle.volumeTiers?.length) return 0;
  let pct = 0;
  for (const t of bundle.volumeTiers) {
    if (quantity >= t.minQuantity) pct = t.discountPercent;
  }
  return pct;
}

/**
 * A bundle whose held quantity earns a volume discount, plus the per-period usage
 * credit it earns for the interval (mirrors `ActiveComboCredit`).
 */
export interface ActiveVolumeCredit {
  bundleId: string;
  name: string;
  /** `round(unit × quantity × pct / 100)` for the interval — the discount amount. */
  creditCents: number;
}

/**
 * Which held add-ons earn a volume discount, and the per-period usage credit each
 * earns for `interval`. Pure + side-effect-free (like `activeComboCredits`), so
 * preview, price breakdown, and the invoice reconciler all derive the same numbers.
 */
export function volumeCredits(
  addons: readonly { bundleId: string; quantity: number }[],
  bundles: readonly BundleConfig[],
  interval: BillingInterval,
): ActiveVolumeCredit[] {
  const out: ActiveVolumeCredit[] = [];
  for (const a of addons) {
    const b = bundles.find((x) => x.id === a.bundleId);
    if (!b?.volumeTiers?.length) continue;
    const pct = volumeDiscountPct(b, a.quantity);
    if (pct <= 0) continue;
    const creditCents = Math.round((priceForInterval(b.prices, interval) * a.quantity * pct) / 100);
    if (creditCents > 0) out.push({ bundleId: b.id, name: b.name, creditCents });
  }
  return out;
}

/** The synthetic `creditLedger.discountId` a bundle's per-period volume credit is
 *  keyed by (`volume:<bundleId>`). Parallel to `comboLedgerId`. */
export function volumeLedgerId(bundleId: string): string {
  return `volume:${bundleId}`;
}

/** The synthetic `creditLedger.discountId` a combo's per-period credit is keyed by
 *  (`combo:<id>`). A single source for this cross-file contract — the writer and the
 *  idempotency guard MUST agree, so a typo can't silently break dedup. */
export function comboLedgerId(comboId: string): string {
  return `combo:${comboId}`;
}

/**
 * Select the price for a billing interval — the single source for the
 * `interval === 'annual' ? prices.annual : prices.monthly` selection that the
 * credit-math paths (combo basis, recurring re-grant) would otherwise each re-derive.
 */
export function priceForInterval(prices: { readonly monthly: number; readonly annual: number }, interval: BillingInterval): number {
  return interval === 'annual' ? prices.annual : prices.monthly;
}

/**
 * The combo's minimum-composition basket for `interval`:
 * `Σ member unit price × minQty`. The credit basis every path derives from — reused
 * by `activeComboCredits`, the catalog `comboSavings`, and the config guardrail so
 * the math can't drift. Extra quantity beyond the minimum does NOT inflate it, so the
 * combo credit is flat regardless of how many stackable packs are held.
 */
export function comboBasisCents(combo: ComboDiscountConfig, bundles: readonly BundleConfig[], interval: BillingInterval): number {
  return combo.bundleIds.reduce((sum, id) => {
    const b = bundles.find((x) => x.id === id);
    const qty = minQty(combo, id);
    // Post-volume unit price: a combo member with volume tiers (e.g. `seat`) is
    // basised on its DISCOUNTED unit at the combo's minQty, so a volume discount
    // and the combo credit can't stack on the same units (one basis, no drift).
    const rawUnit = b ? priceForInterval(b.prices, interval) : 0;
    const pct = b ? volumeDiscountPct(b, qty) : 0;
    const unit = Math.round((rawUnit * (100 - pct)) / 100);
    return sum + unit * qty;
  }, 0);
}

/** The combined (bundled) price for `interval`. */
function combinedCents(combo: ComboDiscountConfig, interval: BillingInterval): number {
  return priceForInterval(combo.prices, interval);
}

/** The flat credit a combo earns for `interval` (`basket − combined`, clamped ≥ 0). */
function comboCreditCents(combo: ComboDiscountConfig, bundles: readonly BundleConfig[], interval: BillingInterval): number {
  return Math.max(0, comboBasisCents(combo, bundles, interval) - combinedCents(combo, interval));
}

/** A satisfied combo with its members + credit, ready for packing. */
interface Candidate {
  combo: ComboDiscountConfig;
  members: string[];
  creditCents: number;
}

/**
 * Exact max-weight set packing: from `candidates` (satisfied, positive-credit
 * combos), pick the subset with NO two combos sharing a member bundle that
 * maximizes total credit — the member-friendly rule (the customer always gets the
 * largest total discount, and a shared add-on is never discounted twice).
 *
 * Exact via recursion over the tiny candidate set. On an exact total-credit tie the
 * canonical winner is the packing whose sorted comboId list is lexicographically
 * smallest, so the result is stable across runs/tests. Above `EXACT_PACKING_CAP`
 * candidates it falls back to a greedy claim-in-order pass (logged, never silent).
 */
function pickBestPacking(candidates: Candidate[]): Candidate[] {
  // Deterministic order: biggest credit first, then sortOrder, then id.
  const ordered = [...candidates].sort((a, b) =>
    b.creditCents - a.creditCents ||
    a.combo.sortOrder - b.combo.sortOrder ||
    (a.combo.id < b.combo.id ? -1 : a.combo.id > b.combo.id ? 1 : 0),
  );

  if (ordered.length > EXACT_PACKING_CAP) {
    logger.warn('Combo packing exceeded exact-search cap; using greedy fallback', { candidates: ordered.length });
    const claimed = new Set<string>();
    const picked: Candidate[] = [];
    for (const c of ordered) {
      if (c.members.some((m) => claimed.has(m))) continue;
      c.members.forEach((m) => claimed.add(m));
      picked.push(c);
    }
    return picked;
  }

  const idTuple = (set: Candidate[]) => set.map((c) => c.combo.id).sort().join('\u0000');
  let best: Candidate[] = [];
  let bestTotal = -1;

  const recurse = (i: number, claimed: Set<string>, chosen: Candidate[], total: number): void => {
    if (i === ordered.length) {
      if (total > bestTotal || (total === bestTotal && idTuple(chosen) < idTuple(best))) {
        best = [...chosen];
        bestTotal = total;
      }
      return;
    }
    const c = ordered[i];
    // Branch: take c (if its members don't collide with the claimed set)...
    if (!c.members.some((m) => claimed.has(m))) {
      c.members.forEach((m) => claimed.add(m));
      chosen.push(c);
      recurse(i + 1, claimed, chosen, total + c.creditCents);
      chosen.pop();
      c.members.forEach((m) => claimed.delete(m));
    }
    // ...or skip c.
    recurse(i + 1, claimed, chosen, total);
  };
  recurse(0, new Set(), [], 0);
  return best;
}

/**
 * Which combo discounts apply to `addons`, and the per-period usage credit each
 * earns for `interval`. A combo is *satisfied* when every member bundle is present
 * at ≥ its minimum quantity (counts purchased add-ons, not effective tier limits).
 * Overlapping satisfied combos are resolved by exact max-weight packing so a shared
 * add-on is never discounted twice. Pure + side-effect-free, so preview, price
 * breakdown, and the invoice reconciler all derive the same numbers.
 */
export function activeComboCredits(
  addons: readonly { bundleId: string; quantity: number }[],
  bundles: readonly BundleConfig[],
  combos: readonly ComboDiscountConfig[],
  interval: BillingInterval,
): ActiveComboCredit[] {
  const owned = new Map<string, number>();
  for (const a of addons) owned.set(a.bundleId, (owned.get(a.bundleId) ?? 0) + a.quantity);

  const candidates: Candidate[] = [];
  for (const combo of combos) {
    if (combo.bundleIds.length < 2) continue;
    if (!combo.bundleIds.every((id) => (owned.get(id) ?? 0) >= minQty(combo, id))) continue;
    const creditCents = comboCreditCents(combo, bundles, interval);
    if (creditCents > 0) candidates.push({ combo, members: [...combo.bundleIds], creditCents });
  }

  return pickBestPacking(candidates).map((c) => ({ comboId: c.combo.id, name: c.combo.name, creditCents: c.creditCents }));
}
