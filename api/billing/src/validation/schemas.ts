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

