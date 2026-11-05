// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BILLING_INTERVALS, SUBSCRIPTION_STATUSES } from '@pipeline-builder/api-core';
import { z } from 'zod';

const BillingIntervalSchema = z.enum(BILLING_INTERVALS);

/**
 * Schema for creating a new subscription (POST /billing/subscriptions).
 */
export const SubscriptionCreateSchema = z.object({
  planId: z.string().min(1, 'Plan ID is required'),
  interval: BillingIntervalSchema.default('monthly'),
  /** Optional referral code (= the referrer's org id) — credits the referee now
   *  and the referrer once this org first pays. See docs/billing-discounts.md#promotions. */
  referralCode: z.string().min(1).max(64).optional(),
});

/**
 * Schema for updating a subscription (PUT /billing/subscriptions/:id).
 * At least one of planId or interval must be provided (validated in route).
 */
export const SubscriptionUpdateSchema = z.object({
  planId: z.string().min(1).optional(),
  interval: BillingIntervalSchema.optional(),
});

/**
 * Schema for add-on bundle mutations (POST /billing/subscriptions/:id/addons and
 * its /preview variant). Bounds `quantity` to a sane range so a malformed body
 * can't inject `NaN` (non-numeric input is rejected outright) or an unbounded
 * value into the effective-entitlement math. `quantity` stays optional and
 * allows 0 — the add route coerces 0→1 (min purchasable) and preview treats 0
 * as a removal dry-run; the 1000 cap is the reasonable per-request ceiling.
 */
export const AddonMutateSchema = z.object({
  bundleId: z.string().min(1, 'bundleId is required'),
  quantity: z.number().int().min(0).max(1000).optional(),
});

/**
 * A BASKET of add-ons applied in ONE change (docs/plans/sales-agent.md F6).
 *
 * `useAddonChange` changes one add-on at a time, so a three-item basket was
 * three calls — and a partially-applied basket is worse than either end state:
 * the account has paid for part of an offer that was sized as a whole, and the
 * dimensions still under pressure are the ones whose purchase failed.
 *
 * At most eight items, because a basket is sized to the dimensions actually
 * under pressure and there are not eight of those — a larger one is a mistake or
 * an abuse, not a purchase.
 */
export const AddonBasketSchema = z.object({
  items: z.array(z.object({
    bundleId: z.string().min(1, 'bundleId is required'),
    // Zero is NOT allowed here, unlike the single-add schema: a basket is a
    // purchase. Removing an add-on is its own verb, and letting a basket carry
    // removals would make one call both buy and cancel under one confirmation.
    quantity: z.number().int().min(1).max(1000),
  })).min(1, 'at least one item is required').max(8, 'at most eight items'),
});

/**
 * Schema for admin subscription override (PUT /billing/admin/subscriptions/:id).
 */
export const AdminSubscriptionUpdateSchema = z.object({
  planId: z.string().min(1).optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  interval: BillingIntervalSchema.optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
});

// ─── Discounts (docs/billing-discounts.md) ──────────────────────────

/** A short human-friendly public alias — letters/digits/`-`/`_`, uppercased downstream. */
const DiscountAliasSchema = z.string().regex(/^[A-Za-z0-9_-]{3,40}$/, 'alias must be 3-40 of letters, digits, - or _');

/**
 * Schema for minting a discount (POST /billing/admin/discounts). `code` is the
 * human-readable authoring form `value:unit:kind[:campaign]` — it is parsed +
 * ceiling-checked in the route (not here), so this only bounds the envelope.
 * `targetOrgId` binds the discount to one account; omit for a public promo
 * (which then usually carries an `alias`).
 */
export const DiscountMintSchema = z.object({
  code: z.string().min(1, 'code is required'),
  targetOrgId: z.string().min(1).optional(),
  alias: DiscountAliasSchema.optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
  redeemBy: z.string().datetime().optional(),
  appliesToTiers: z.array(z.string().min(1)).max(10).optional(),
  appliesToBundles: z.array(z.string().min(1)).max(20).optional(),
  campaign: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

/** Schema for editing / revoking a discount (PUT /billing/admin/discounts/:id). */
export const DiscountUpdateSchema = z.object({
  isActive: z.boolean().optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
  redeemBy: z.string().datetime().optional(),
  appliesToTiers: z.array(z.string().min(1)).max(10).optional(),
  appliesToBundles: z.array(z.string().min(1)).max(20).optional(),
});

/** Schema for the system direct-grant path (POST /admin/discounts/:id/apply). */
export const DiscountApplySchema = z.object({
  targetOrgId: z.string().min(1, 'targetOrgId is required'),
});

/**
 * Schema for self-service redemption (POST /subscriptions/:id/discounts). `code`
 * is an opaque token OR a public alias — the route resolves which. A body
 * `targetOrgId` is intentionally absent: self-service can only ever apply to the
 * caller's own account.
 */
export const DiscountRedeemSchema = z.object({
  code: z.string().min(1, 'code is required'),
});

// ── Campaigns (the identity a set of discount codes belongs to) ──────

/** A campaign slug — same character set as the old label, normalized downstream. */
const CampaignIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'campaign may contain only letters, digits, "-" and "_" (max 64)');

/** Schema for creating a campaign (POST /billing/admin/campaigns). */
export const CampaignCreateSchema = z.object({
  id: CampaignIdSchema,
  name: z.string().min(1).max(200),
  /** Total cents the whole campaign may give away; omit for unlimited. */
  budgetCents: z.number().int().min(1).max(100_000_000).optional(),
  /** One redemption per account across every code in the campaign. */
  exclusive: z.boolean().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});

/** Schema for editing / ending a campaign (PUT /billing/admin/campaigns/:id). */
export const CampaignUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  budgetCents: z.number().int().min(1).max(100_000_000).optional(),
  exclusive: z.boolean().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  isActive: z.boolean().optional(),
});

// ── Promotions (rule-driven auto-grant campaigns) ────────────────────

const PromotionConditionsSchema = z.object({
  tiers: z.array(z.string().min(1)).max(10).optional(),
  intervals: z.array(z.enum(['monthly', 'annual'])).max(2).optional(),
  firstSubscriptionOnly: z.boolean().optional(),
});

/** Mint a promotion (POST /billing/admin/promotions). */
export const PromotionMintSchema = z.object({
  name: z.string().min(1).max(120),
  campaign: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  value: z.number().int().min(1),
  unit: z.enum(['dollar', 'percent']),
  kind: z.enum(['onetime', 'recurring']).optional().default('onetime'),
  /** For a `referral` promotion: the referrer's grant magnitude (referee uses `value`). */
  referrerValue: z.number().int().min(1).optional(),
  trigger: z.object({
    event: z.enum(['subscription_created', 'plan_change', 'manual', 'referral']),
    conditions: PromotionConditionsSchema.optional(),
  }),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  budgetCents: z.number().int().min(1).max(1_000_000_000),
  perOrgCapCents: z.number().int().min(1).optional(),
  maxGrants: z.number().int().min(1).max(10_000_000).optional(),
}).refine((v) => v.unit !== 'percent' || v.value <= 100, {
  message: 'percent value must be ≤ 100',
  path: ['value'],
}).refine((v) => v.unit !== 'percent' || v.referrerValue == null || v.referrerValue <= 100, {
  message: 'percent referrerValue must be ≤ 100',
  path: ['referrerValue'],
});

/** Edit / activate / revoke a promotion (PUT /billing/admin/promotions/:id). */
export const PromotionUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  endsAt: z.string().datetime().optional(),
  budgetCents: z.number().int().min(1).max(1_000_000_000).optional(),
  maxGrants: z.number().int().min(1).max(10_000_000).optional(),
});

/** Manual admin grant to one org (POST /billing/admin/promotions/:id/grant). */
export const PromotionGrantSchema = z.object({
  targetOrgId: z.string().min(1, 'targetOrgId is required'),
});

