// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AI_KEY_SOURCES, PRINCIPAL_TYPES, VALID_QUOTA_TYPES, VALID_TIERS, type PrincipalType } from '@pipeline-builder/api-core';
import { z } from 'zod';

const quotaLimit = z.number().int().min(-1);

// Derive the per-type quota limit shape programmatically so that adding a new
// QuotaType to api-core surfaces here automatically (no drift).
const quotasShape: z.ZodRawShape = Object.fromEntries(
  VALID_QUOTA_TYPES.map((t) => [t, quotaLimit.optional()]),
);

/** PUT /quotas/:orgId  update org name, slug, tier, and/or quota limits. */
export const UpdateQuotaSchema = z.object({
  name: z.string().trim().min(1, 'name must be a non-empty string').optional(),
  slug: z.string().trim().min(1, 'slug must be a non-empty string')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with hyphens (e.g. "my-org")')
    .optional(),
  tier: z.enum(VALID_TIERS as readonly [string, ...string[]]).optional(),
  quotas: z.object(quotasShape).optional(),
}).refine( (data) => data.name !== undefined || data.slug !== undefined || data.tier !== undefined || data.quotas !== undefined,
  { message: 'At least one field (name, slug, tier, or quotas) is required.' },
);

/** Bounded opaque attribution string (ids, route patterns). */
const attributionText = z.string().trim().min(1).max(200);

/**
 * Usage-ledger attribution riding an increment / decrement (api-core
 * `QuotaUsageAttribution`). Metadata only — enforcement never reads it — and
 * only ever sent by an internal service (the routes are service-only), from a
 * VERIFIED inbound token. Unknown keys are stripped.
 */
export const UsageAttributionSchema = z.object({
  principalType: z.enum(PRINCIPAL_TYPES as unknown as readonly [PrincipalType, ...PrincipalType[]]).optional(),
  principalId: attributionText.optional(),
  keyId: attributionText.optional(),
  route: attributionText.optional(),
  pipelineId: attributionText.optional(),
  requestId: attributionText.optional(),
  // AI calls only (api-server `withAiCallReservation`): the product surface,
  // the model id and whose key served it.
  feature: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_:-]*$/, 'feature must be a lowercase slug').optional(),
  model: attributionText.optional(),
  keySource: z.enum(AI_KEY_SOURCES).optional(),
});

const quotaTypeEnum = z.enum(VALID_QUOTA_TYPES, {
  message: `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`,
});

/**
 * Per-call ceiling on a RESERVATION's `amount`. A buggy or malicious caller
 * passing `amount: 1_000_000` could exhaust the org's quota in one call; 1000 is
 * well above any legitimate batch size we issue today.
 */
export const MAX_RESERVE_AMOUNT = 1000;

/**
 * Ceiling on one METERED increment — a pod's per-flush sum for one (org, type).
 * Far above any real per-second rate; it only stops a nonsense figure.
 */
export const MAX_METERED_AMOUNT = 1_000_000;

/** Most attribution groups one metered increment may carry (api-core sends ≤ this). */
export const MAX_METERED_GROUPS = 500;

/** One attribution group of a metered increment. */
const MeteredGroupSchema = z.object({
  amount: z.number().int().min(1).max(MAX_METERED_AMOUNT),
  attribution: UsageAttributionSchema.optional(),
});

/**
 * POST /quotas/:orgId/increment  increment usage for a quota type.
 *
 * Two shapes on one internal route:
 *  - a RESERVATION (default): all-or-nothing, 429 when it does not fit, `amount`
 *    ≤ {@link MAX_RESERVE_AMOUNT};
 *  - a METERED batch (`meter: true`, from api-core's per-pod increment batcher):
 *    `groups` carry per-attribution amounts summing to `amount`, admitted
 *    PARTIALLY — never a 429, the excess recorded as overshoot.
 */
export const IncrementQuotaSchema = z.object({
  quotaType: quotaTypeEnum,
  amount: z.number().int().min(1).max(MAX_METERED_AMOUNT).default(1),
  attribution: UsageAttributionSchema.optional(),
  meter: z.literal(true).optional(),
  groups: z.array(MeteredGroupSchema).min(1).max(MAX_METERED_GROUPS).optional(),
}).superRefine((d, ctx) => {
  if (!d.meter) {
    if (d.amount > MAX_RESERVE_AMOUNT) ctx.addIssue({ code: 'custom', path: ['amount'], message: `amount must be at most ${MAX_RESERVE_AMOUNT}` });
    if (d.groups) ctx.addIssue({ code: 'custom', path: ['groups'], message: '`groups` is only accepted with `meter: true`' });
    return;
  }
  if (d.groups && d.groups.reduce((sum, g) => sum + g.amount, 0) !== d.amount) {
    ctx.addIssue({ code: 'custom', path: ['groups'], message: 'group amounts must sum to `amount`' });
  }
});

/** Largest token count one usage report may carry (far above any single call's). */
export const MAX_REPORTED_TOKENS = 100_000_000;

/**
 * POST /quotas/:orgId/increment with `report: true` — an AI call's AFTER-THE-CALL
 * usage report (api-core `QuotaService.reportUsage`): its token counts, under
 * the call's attribution. Moves NO counter; writes a zero-unit ledger row, which
 * is also how a call that spent no unit (BYOK, impersonation, weight 0) shows
 * up in the usage breakdown.
 */
export const ReportUsageSchema = z.object({
  quotaType: z.literal('aiCalls'),
  report: z.literal(true),
  tokensIn: z.number().int().min(0).max(MAX_REPORTED_TOKENS).default(0),
  tokensOut: z.number().int().min(0).max(MAX_REPORTED_TOKENS).default(0),
  attribution: UsageAttributionSchema.optional(),
});

/**
 * POST /quotas/:orgId/decrement  roll back a previously reserved increment.
 * The reservation shape; same per-call ceiling so a buggy rollback can't drive
 * the counter wildly negative (the service also floors at 0).
 */
export const DecrementQuotaSchema = z.object({
  quotaType: quotaTypeEnum,
  amount: z.number().int().min(1).max(MAX_RESERVE_AMOUNT).default(1),
  // Optional snapshot of the `resetAt` observed at reserve time. When present,
  // the service no-ops the decrement if the period rolled over between reserve
  // and rollback (prevents stealing from the next period).
  resetAtSnapshot: z.string().datetime({ offset: true }).optional(),
  attribution: UsageAttributionSchema.optional(),
});

/** POST /quotas/:orgId/reset  reset usage counters. */
export const ResetQuotaSchema = z.object({
  quotaType: quotaTypeEnum.optional(),
});

/** The `groupBy` values `GET /quotas/:orgId/usage` accepts. */
export const USAGE_GROUP_BY = ['principal', 'route', 'pipeline', 'day', 'feature', 'model'] as const;

/** Longest window one usage read may span (the ledger keeps 90 days by default). */
export const USAGE_MAX_RANGE_DAYS = 400;

/** GET /quotas/:orgId/usage  query string. `from`/`to` default to the current period. */
export const UsageQuerySchema = z.object({
  type: z.enum(VALID_QUOTA_TYPES).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  groupBy: z.enum(USAGE_GROUP_BY).default('principal'),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Largest per-period AI token budget an account may set (1e12 — effectively "very large"). */
export const MAX_AI_TOKEN_BUDGET = 1_000_000_000_000;

/**
 * PUT /quotas/:orgId/notice-settings — the account's quota settings: the
 * threshold notices, plus the two OPTIONAL AI controls (default off; `null`
 * clears one):
 *  - `aiCallsPerMemberPct` — the most any ONE member may spend of the account's
 *    `aiCalls` per period, as a percent of its limit (1–100);
 *  - `aiTokenBudget` — total platform-key AI tokens (in + out) the account may
 *    spend per period; past it new AI calls are refused.
 */
export const NoticeSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /**
   * The account's EXPANSION-OFFERS switch (docs/plans/sales-agent.md D6/F7).
   *
   * It lives on this row rather than in billing because the two switches are
   * ANDed at send time — an offer rides the quota-notice channel, so an account
   * that silenced that channel has already answered for both — and a consent
   * pair split across two services is a pair that gets read inconsistently.
   * Default TRUE (opt-out): stored `null` means "never said", which reads as on.
   */
  offersEnabled: z.boolean().optional(),
  // HTTPS only; the SSRF vetting happens at save time AND at every delivery.
  webhookUrl: z.string().trim().url().max(2048).refine((u) => u.startsWith('https://'), 'webhookUrl must be an https:// URL').nullable().optional(),
  aiCallsPerMemberPct: z.number().int().min(1).max(100).nullable().optional(),
  aiTokenBudget: z.number().int().min(1).max(MAX_AI_TOKEN_BUDGET).nullable().optional(),
}).refine(
  (d) => d.enabled !== undefined || d.offersEnabled !== undefined || d.webhookUrl !== undefined
    || d.aiCallsPerMemberPct !== undefined || d.aiTokenBudget !== undefined,
  { message: 'At least one of enabled, offersEnabled, webhookUrl, aiCallsPerMemberPct or aiTokenBudget is required.' },
);
