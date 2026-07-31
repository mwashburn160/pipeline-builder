// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

const BillingIntervalSchema = z.enum(['monthly', 'annual']);

/**
 * Schema for creating a new subscription (POST /billing/subscriptions).
 */
export const SubscriptionCreateSchema = z.object({
  planId: z.string().min(1, 'Plan ID is required'),
  interval: BillingIntervalSchema.default('monthly'),
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
 * Schema for admin subscription override (PUT /billing/admin/subscriptions/:id).
 */
export const AdminSubscriptionUpdateSchema = z.object({
  planId: z.string().min(1).optional(),
  status: z.enum(['active', 'canceled', 'past_due', 'trialing', 'incomplete']).optional(),
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
  campaign: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

/** Schema for editing / revoking a discount (PUT /billing/admin/discounts/:id). */
export const DiscountUpdateSchema = z.object({
  isActive: z.boolean().optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
  redeemBy: z.string().datetime().optional(),
  appliesToTiers: z.array(z.string().min(1)).max(10).optional(),
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

