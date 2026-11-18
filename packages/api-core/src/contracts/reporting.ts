// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY reporting.
 *
 *  - org purge: platform's cascade outbox tears a deleted org's stakeholder
 *    reports, share links, DORA/incident data, ingested events and analytics
 *    rollups out of the reporting tables.
 *  - retention sync: billing pushes (and its drift reconciler reads back) the
 *    account's effective retention entitlement.
 *  - stakeholder sync: billing says whether the account still holds the
 *    Stakeholder Reports add-on (pauses / resumes every report in it).
 *  - owner left: platform pauses the report definitions a departing member owns.
 *
 * Every one is served under `/reports/internal/…`, which the gateway never
 * routes from outside.
 */

import { z } from 'zod';
import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';
import { normalizeRetentionDays, RETENTION_MAX_DAYS } from '../utils/retention.js';

const BILLING_SYNC_AUTH = "billing's own service token (no user token, however privileged). "
  + 'The org is the PATH param — the account root billing resolved — not the token org.';

const ORG_ID_REQUIRED = 'orgId path parameter is required';

/** The target root org in the path, as sent (the routes key on it verbatim). */
const SyncOrgParams = z.object({ orgId: z.string({ error: ORG_ID_REQUIRED }).min(1, ORG_ID_REQUIRED) });

/**
 * One retention value: the unlimited sentinel `-1`, or an integer ≥ 1 clamped
 * to {@link RETENTION_MAX_DAYS}. Anything else is refused with the route's
 * own message.
 */
function retentionDays(field: string) {
  const message = `${field} must be -1 or an integer in [1, ${RETENTION_MAX_DAYS}]`;
  return z.unknown().transform((v, ctx): number => {
    const days = normalizeRetentionDays(v);
    if (days === null) {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
    return days;
  });
}

/**
 * Billing's `occurredAt` for the retention push: kept only when it is a real
 * instant (it is copied into the audit row), else dropped — never a 400.
 */
const retentionOccurredAt = z.unknown().optional().transform((v): string | undefined => (
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined
));

/**
 * The pause reasons platform may give for a departing owner: the stored pause
 * vocabulary minus `entitlement`, which is billing's to declare (the
 * stakeholder-sync leg). Mirrors pipeline-data's `REPORT_PAUSE_REASONS`
 * (reporting's contract test pins the two together).
 */
export const OWNER_LEFT_PAUSE_REASONS = ['owner_inactive', 'permission_lost'] as const;

/** A paused definition as platform names it to the org's admins; malformed entries are dropped. */
const pausedReports = z.unknown().optional().transform((v): Array<{ id: string; name: string; cadence: string }> => {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p: unknown) => {
    if (!p || typeof p !== 'object') return [];
    const { id, name, cadence } = p as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    return [{ id, name, cadence: typeof cadence === 'string' ? cadence : '' }];
  });
});

export const REPORTING_INTERNAL = {
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'reporting.purgeOrg',
    service: 'reporting',
    method: 'POST',
    path: '/reports/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
  /**
   * Store the account's EFFECTIVE retention (tier + bundles; `-1` = unlimited)
   * on the root org's settings. Idempotent (an upsert of the same values).
   */
  syncRetention: defineInternalEndpoint({
    id: 'reporting.syncRetention',
    service: 'reporting',
    method: 'PUT',
    path: '/reports/internal/retention-sync/:orgId',
    callers: ['billing'],
    auth: BILLING_SYNC_AUTH,
    params: SyncOrgParams,
    body: z.object({
      eventRetentionDays: retentionDays('eventRetentionDays'),
      doraRetentionDays: retentionDays('doraRetentionDays'),
      occurredAt: retentionOccurredAt,
    }),
    response: z.object({
      orgId: z.string(),
      eventRetentionDays: z.number(),
      doraRetentionDays: z.number(),
      ok: z.literal(true),
    }),
  }),
  /** Drift read: the retention reporting ENFORCES for the root org (`null` = none stored). */
  readRetention: defineInternalEndpoint({
    id: 'reporting.readRetention',
    service: 'reporting',
    method: 'GET',
    path: '/reports/internal/retention-sync/:orgId',
    callers: ['billing'],
    auth: BILLING_SYNC_AUTH,
    params: SyncOrgParams,
    response: z.object({
      /** Always sent; the drift read compares only the two values. */
      orgId: z.string().optional(),
      eventRetentionDays: z.number().int().nullable(),
      doraRetentionDays: z.number().int().nullable(),
    }),
  }),
  /**
   * The account gained or lost Stakeholder Reports: pause (`entitlement`) or
   * resume every report in the ACCOUNT (root + teams). Ordered by
   * `occurredAt` — an org whose last applied edge is newer counts as
   * `staleOrgs`. 503 when the account hierarchy cannot be resolved (nothing
   * is applied; billing retries).
   */
  syncStakeholderEntitlement: defineInternalEndpoint({
    id: 'reporting.syncStakeholderEntitlement',
    service: 'reporting',
    method: 'PUT',
    path: '/reports/internal/stakeholder-sync/:orgId',
    callers: ['billing'],
    auth: BILLING_SYNC_AUTH,
    params: SyncOrgParams,
    body: z.object({
      entitled: z.boolean({ error: 'must be a boolean' }),
      /** Any string `Date` parses (billing sends ISO). */
      occurredAt: z.string({ error: 'must be an ISO timestamp' })
        .refine((v) => !Number.isNaN(new Date(v).getTime()), 'must be an ISO timestamp')
        .optional(),
    }).strict(),
    response: z.object({
      ok: z.literal(true),
      paused: z.number(),
      resumed: z.number(),
      staleOrgs: z.number(),
    }),
  }),
  /**
   * Pause every ACTIVE definition `userId` owns in `orgId`, recording `reason`.
   * Idempotent: an already-paused definition is untouched (no second audit, the
   * first reason kept), so a retry answers with only what it newly paused.
   */
  ownerLeft: defineInternalEndpoint({
    id: 'reporting.ownerLeft',
    service: 'reporting',
    method: 'POST',
    path: '/reports/internal/stakeholder/owner-left/:orgId/:userId',
    callers: ['platform'],
    auth: "platform's service token (system-org member); the org is the PATH param.",
    params: z.object({
      orgId: z.string({ error: 'orgId and userId are required' }).toLowerCase().min(1, 'orgId and userId are required'),
      userId: z.string({ error: 'orgId and userId are required' }).min(1, 'orgId and userId are required'),
    }),
    body: z.object({ reason: z.enum(OWNER_LEFT_PAUSE_REASONS) }).strict(),
    response: z.object({ paused: pausedReports }),
  }),
} as const;
