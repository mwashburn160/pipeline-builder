// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaTier, QuotaTierLimits } from '@pipeline-builder/api-core';

/** Price configuration for a single billing plan (in cents). */
export interface BillingPlanPrices {
  readonly monthly: number;
  readonly annual: number;
}

/** Full billing plan definition used for seeding and runtime configuration. */
export interface BillingPlanConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tier: QuotaTier;
  readonly prices: BillingPlanPrices;
  readonly features: readonly string[];
  readonly isActive: boolean;
  readonly isDefault: boolean;
  readonly sortOrder: number;
}

/**
 * A purchasable add-on bundle: a quantity-stackable pack that ADDS to the
 * account's base (tier) limits and adds a recurring line item. See
 * docs/billing-bundles.md.
 */
export interface BundleConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Per-unit deltas on `QuotaTierLimits` fields, e.g. `{ seats: 5 }`. Keys are
   *  constrained to real quota fields so a typo is a compile error (was
   *  `Record<string, number>`, where a misspelled key was silently unenforceable). */
  readonly grants: Readonly<Partial<Record<keyof QuotaTierLimits, number>>>;
  /** Feature flags granted by a feature bundle (e.g. `advanced_reporting`). */
  readonly features?: readonly string[];
  /** Per-unit price (cents). Stripe multiplies by quantity. */
  readonly prices: BillingPlanPrices;
  /** True for stackable resource packs; false for a boolean feature bundle. */
  readonly stackable: boolean;
  /**
   * Maximum purchasable quantity for a stackable pack. Enforced by the addon
   * purchase/preview route (`quantity ≤ maxQuantity`, reject over-cap). Used to
   * keep retention packs under the 730-day retention ceiling (e.g. the Standard
   * Retention Pack caps at 7 so 30 + 7×90 = 660 ≤ 730). Absent ⇒ unbounded.
   */
  readonly maxQuantity?: number;
  /**
   * Optional per-unit volume discount tiers for a stackable pack: at ≥ `minQuantity`
   * purchased units, `discountPercent` comes off the line subtotal (unit × quantity).
   * The highest matching tier wins. Realized as a recurring usage credit (like a
   * combo), so the provider still charges unit×qty and the credit offsets the
   * balance. Env-overridable via `BILLING_BUNDLE_<ID>_VOLUME_TIERS` (JSON). Used by
   * the per-seat `seat` bundle. Absent ⇒ no volume discount.
   */
  readonly volumeTiers?: readonly { readonly minQuantity: number; readonly discountPercent: number }[];
  /** Base tiers this bundle is offered to. */
  readonly availableForTiers: readonly QuotaTier[];
  /**
   * Prerequisite bundle ids that must be held (or purchased in the same action)
   * before this bundle can be added. Enforced by the addon purchase/preview route
   * (reject with 400 when unmet); a combo that includes the prerequisite satisfies
   * it. Used by `compliance_advanced` (`requires: ['compliance_standard']`).
   * Absent ⇒ no prerequisite.
   */
  readonly requires?: readonly string[];
  /**
   * Prerequisite FEATURE flags the account must hold — from its plan tier
   * (`TIER_FEATURES`) or from a feature bundle it holds after the change — before
   * this bundle can be added. Distinct from {@link requires} because a feature can
   * be tier-included (no bundle to name): e.g. `dora_history_pack` needs
   * `advanced_reporting`, which Enterprise includes and lower tiers buy as an
   * add-on. Enforced by the addon purchase/preview route (400 when unmet), and a
   * held bundle whose feature prerequisite disappears (its granting bundle removed,
   * or a downgrade to a tier without it) is cascade-removed. Absent ⇒ none.
   */
  readonly requiresFeatures?: readonly string[];
  readonly isActive: boolean;
  readonly sortOrder: number;
}

/**
 * A combo discount: when an account holds EVERY bundle in `bundleIds`, the pair
 * is billed at `prices` (the combined price) instead of the sum of the members'
 * individual prices. Realized as a recurring usage credit for the difference —
 * never a provider coupon — consistent with the usage-credit discount model. See
 * docs/billing-bundles.md §Combo pricing.
 */
export interface ComboDiscountConfig {
  readonly id: string;
  readonly name: string;
  /** The member bundle ids that must ALL be present for the combo to apply. */
  readonly bundleIds: readonly string[];
  /** Per-member minimum quantity (bundleId → count; absent ⇒ 1). Lets a stackable
   *  capacity pack anchor a combo — e.g. `{ seat: 5 }` = "≥ 5 seats". The credit
   *  basis uses this minimum, so extra units never inflate the discount. */
  readonly minQuantities?: Readonly<Record<string, number>>;
  /** The combined price for the minimum set (cents). The credit is
   *  `Σ member unit price × minQty − prices`, clamped ≥ 0. */
  readonly prices: BillingPlanPrices;
  /** Deterministic tie-break among equal-total optimal packings when combos overlap
   *  (lower wins). */
  readonly sortOrder: number;
  readonly isActive: boolean;
}

/** Billing plans + add-on bundle configuration. */
export interface BillingConfig {
  readonly plans: readonly BillingPlanConfig[];
  readonly bundles: readonly BundleConfig[];
  readonly comboDiscounts: readonly ComboDiscountConfig[];
}
