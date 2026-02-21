/**
 * @module validation/schemas
 * @description Zod schemas for quota route input validation.
 */

import { z } from 'zod';
import { VALID_QUOTA_TYPES } from '../helpers/quota-helpers';
const VALID_TIERS = ['developer', 'pro', 'unlimited'] as const;

const quotaLimit = z.number().int().min(-1);

/** PUT /quotas/:orgId — update org name, slug, tier, and/or quota limits. */
export const UpdateQuotaSchema = z.object({
  name: z.string().trim().min(1, 'name must be a non-empty string').optional(),
  slug: z.string().trim().min(1, 'slug must be a non-empty string')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with hyphens (e.g. "my-org")')
    .optional(),
  tier: z.enum(VALID_TIERS).optional(),
  quotas: z.object({
    plugins: quotaLimit.optional(),
    pipelines: quotaLimit.optional(),
    apiCalls: quotaLimit.optional(),
  }).optional(),
}).refine(
  (data) => data.name !== undefined || data.slug !== undefined || data.tier !== undefined || data.quotas !== undefined,
  { message: 'At least one field (name, slug, tier, or quotas) is required.' },
);

/** POST /quotas/:orgId/increment — increment usage for a quota type. */
export const IncrementQuotaSchema = z.object({
  quotaType: z.enum(VALID_QUOTA_TYPES, {
    required_error: 'quotaType is required.',
    invalid_type_error: `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`,
  }),
  amount: z.number().int().min(1).default(1),
});

/** POST /quotas/:orgId/reset — reset usage counters. */
export const ResetQuotaSchema = z.object({
  quotaType: z.enum(VALID_QUOTA_TYPES, {
    invalid_type_error: `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`,
  }).optional(),
});
