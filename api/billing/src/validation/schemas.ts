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
 * Schema for admin subscription override (PUT /billing/admin/subscriptions/:id).
 */
export const AdminSubscriptionUpdateSchema = z.object({
  planId: z.string().min(1).optional(),
  status: z.enum(['active', 'canceled', 'past_due', 'trialing', 'incomplete']).optional(),
  interval: BillingIntervalSchema.optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
});

export type ValidatedSubscriptionCreate = z.infer<typeof SubscriptionCreateSchema>;
export type ValidatedSubscriptionUpdate = z.infer<typeof SubscriptionUpdateSchema>;
export type ValidatedAdminSubscriptionUpdate = z.infer<typeof AdminSubscriptionUpdateSchema>;
