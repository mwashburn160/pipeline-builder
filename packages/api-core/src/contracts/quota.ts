// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY quota.
 *
 *  - usage profile: the POOLED per-dimension usage picture billing's
 *    expansion-offers profile is built from, with both consent switches.
 */

import { z } from 'zod';
import { defineInternalEndpoint } from './define.js';

/** One quota dimension as the profile read returns it. */
const ProfileDimension = z.object({
  used: z.number(),
  limit: z.number(),
  /** Null for an unlimited cap (there is no ratio). */
  ratio: z.number().nullable(),
  projected: z.number().nullable(),
  /** ISO timestamp. */
  resetAt: z.string().nullable(),
  periodDays: z.number().nullable(),
});

export const QUOTA_INTERNAL = {
  /**
   * `{ profile }` — the org's pooled usage, keyed by quota type, plus the
   * account root and its two opt-out consent switches.
   */
  usageProfile: defineInternalEndpoint({
    id: 'quota.usageProfile',
    service: 'quota',
    method: 'GET',
    path: '/quotas/internal/:orgId/profile',
    callers: ['billing'],
    auth: 'Service token from billing, which must ALSO pass `authorizeOrg()` for the path org '
      + '(billing mints a token scoped to the account it evaluates and sends `x-org-id`).',
    params: z.object({ orgId: z.string().min(1) }),
    response: z.object({
      profile: z.object({
        orgId: z.string(),
        tier: z.string(),
        rootOrgId: z.string(),
        noticesEnabled: z.boolean(),
        offersEnabled: z.boolean(),
        dimensions: z.record(z.string(), ProfileDimension),
      }),
    }),
  }),
} as const;
