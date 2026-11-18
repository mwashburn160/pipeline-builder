// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY compliance.
 *
 *  - org purge: platform's cascade outbox tears a deleted org's policies,
 *    rules, scans, exemptions and their history out of the compliance tables.
 *  - entity events: pipeline and plugin forward each entity mutation for the
 *    post-mutation compliance re-evaluation.
 *  - auto-subscribe: platform subscribes a newly registered org to the
 *    baseline published rules (inactive).
 *  - entitlement sync: billing pushes (and its drift reconciler reads back) the
 *    curated content sets an account is entitled to.
 *  - posture: reporting reads the counts behind a stakeholder report's
 *    compliance panel.
 *
 * Every one is served under `/compliance/internal/…`, which the gateway never
 * routes from outside.
 */

import { z } from 'zod';
import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';

/**
 * The entity-event body. Producers send their whole `EntityEvent` (its
 * `timestamp` included), so unknown keys pass through untouched — the route
 * reads only the fields below. `userId` is "requested by", never the actor.
 */
const EntityEventBody = z.looseObject({
  entityId: z.string().min(1),
  orgId: z.string().min(1),
  target: z.string().min(1),
  eventType: z.string().min(1),
  userId: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/** The target root org in the path, canonical (trimmed, lowercased). */
const EntitlementOrgParams = z.object({
  orgId: z.string({ error: 'orgId path parameter is required' })
    .trim().toLowerCase().min(1, 'orgId path parameter is required'),
});

const BILLING_ENTITLEMENT_AUTH = "billing's own service token (no user token, however privileged). "
  + 'The org is the PATH param — the account root billing resolved — not the token org.';

/** A non-negative finite count; anything else reads as 0 (the panel renders it). */
const postureCount = z.unknown().optional().transform((v): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
});

/** The latest completed scan, or null when there is none (or `at` is not a string). */
const postureLastScan = z.unknown().optional().transform((v) => {
  if (!v || typeof v !== 'object' || typeof (v as { at?: unknown }).at !== 'string') return null;
  const s = v as Record<string, unknown>;
  const count = (x: unknown) => postureCount.parse(x);
  return {
    at: s.at as string,
    entities: count(s.entities),
    passed: count(s.passed),
    warnings: count(s.warnings),
    blocked: count(s.blocked),
  };
});

export const COMPLIANCE_INTERNAL = {
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'compliance.purgeOrg',
    service: 'compliance',
    method: 'POST',
    path: '/compliance/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
  /**
   * Re-evaluate the org's rules against one mutated entity. 200 with the
   * verdict counts (or `evaluated: false` + `reason` when nothing applied);
   * 500 on an evaluation error so the producer retries (fail closed); 403 when
   * the body's org is not the token's. Naturally idempotent — the producer
   * sends a stable per-event `Idempotency-Key`.
   */
  entityEvent: defineInternalEndpoint({
    id: 'compliance.entityEvent',
    service: 'compliance',
    method: 'POST',
    path: '/compliance/internal/events/entity',
    callers: ['pipeline', 'plugin'],
    auth: "The producer's service token minted for the EVENT's org; the body's orgId must equal the token org (else 403).",
    params: z.object({}),
    body: EntityEventBody,
    response: z.object({
      evaluated: z.boolean(),
      blocked: z.boolean().optional(),
      violations: z.number().optional(),
      warnings: z.number().optional(),
      reason: z.string().optional(),
    }),
  }),
  /**
   * Subscribe the token's org to the baseline (un-tagged) published rules,
   * INACTIVE (nothing enforces until an audited activate). Idempotent: the
   * insert skips existing subscriptions, so a repeat changes nothing.
   */
  autoSubscribe: defineInternalEndpoint({
    id: 'compliance.autoSubscribe',
    service: 'compliance',
    method: 'POST',
    path: '/compliance/internal/subscriptions/auto-subscribe',
    callers: ['platform'],
    auth: "platform's service token minted for the NEW org (plus `x-org-id`); the org is the token's.",
    params: z.object({}),
    /** An empty object: the route reads no body (the org comes from the token). */
    body: z.object({}),
    response: z.object({ subscribed: z.number() }),
  }),
  /**
   * Reconcile the org's curated-library subscriptions to `sets` (unknown set
   * names are ignored, not refused). Idempotent, and ordered by `occurredAt`:
   * a push not newer than the last applied one answers `{ ok, skipped: true }`.
   */
  syncEntitlements: defineInternalEndpoint({
    id: 'compliance.syncEntitlements',
    service: 'compliance',
    method: 'PUT',
    path: '/compliance/internal/entitlements/:orgId',
    callers: ['billing'],
    auth: BILLING_ENTITLEMENT_AUTH,
    params: EntitlementOrgParams,
    body: z.object({
      sets: z.array(z.string()).max(16),
      occurredAt: z.string().datetime().optional(),
    }),
    response: z.object({
      ok: z.literal(true),
      skipped: z.boolean().optional(),
      activated: z.number().optional(),
      deactivated: z.number().optional(),
    }),
  }),
  /** Drift read: the content sets the org currently ENFORCES (active `set:<x>` subscriptions). */
  readEntitlements: defineInternalEndpoint({
    id: 'compliance.readEntitlements',
    service: 'compliance',
    method: 'GET',
    path: '/compliance/internal/entitlements/:orgId',
    callers: ['billing'],
    auth: BILLING_ENTITLEMENT_AUTH,
    params: EntitlementOrgParams,
    response: z.object({ sets: z.array(z.string()) }),
  }),
  /**
   * Posture COUNTS for the token's org (never rule names, entity ids or
   * conditions). 500 when the read failed — the caller shows the panel as
   * unavailable rather than as an empty posture. Counts are read leniently
   * (non-numbers as 0) so one odd field cannot blank the panel.
   */
  posture: defineInternalEndpoint({
    id: 'compliance.posture',
    service: 'compliance',
    method: 'GET',
    path: '/compliance/internal/posture',
    callers: ['reporting'],
    auth: "reporting's service token minted for the report's org; the org is the token's (no path param to disagree with).",
    params: z.object({}),
    response: z.object({
      activeRules: postureCount,
      activeExemptions: postureCount,
      frameworks: z.unknown().optional().transform((v): string[] => (
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      )),
      lastScan: postureLastScan,
    }),
  }),
} as const;
