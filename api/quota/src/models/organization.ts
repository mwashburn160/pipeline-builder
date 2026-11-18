// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { VALID_QUOTA_TYPES, VALID_TIERS, type PlanTier, type QuotaType, nextQuotaResetDate } from '@pipeline-builder/api-core';
import mongoose, { Schema, Document } from 'mongoose';
import { config } from '../config.js';
import { periodDaysFor } from '../helpers/quota-helpers.js';

// Types

interface QuotaUsage {
  used: number;
  resetAt: Date;
  /**
   * The LIMIT this counter started its period with.
   *
   * Captured at the period boundary so a cap can only ever RISE mid-period: the
   * effective cap is `max(limitAtPeriodStart, current)`, which means a downgrade
   * or a cancelled pack applies from the NEXT window rather than stranding an
   * account over a cap it already spent against.
   *
   * It exists because of `cpuCredits`. `checkEntitlementOvercap` refuses a
   * downgrade that would strand an account, but deliberately excludes per-period
   * rate quotas on the grounds that "they reset, so landing over a reduced cap
   * costs at most one period" — true at three days, and a MONTH for credits. A
   * mid-month downgrade could otherwise refuse every build until the window
   * rolled: a month-long outage caused by a billing click.
   *
   * Absent on a counter platform created (its org defaults seed only `used` +
   * `resetAt`) until the first increment rolls or fills it; absent reads as
   * "no snapshot" and falls back to the current limit.
   */
  limitAtPeriodStart?: number;
}

/** Per-type limits, one per `VALID_QUOTA_TYPES` member. -1 means unlimited;
 *  `storageBytes` is the aggregate registry storage cap in bytes. */
export type QuotaLimits = Record<QuotaType, number>;

/**
 * Per-type usage counters, one per `VALID_QUOTA_TYPES` member.
 *
 * `storageBytes` is present for schema parity but is NOT a live counter:
 * nothing increments/decrements it. Registry storage is measured live by the
 * image-registry (`computeStorageUsage` in its storage-usage.ts, cached ~60s)
 * and compared at token-issuance time against the org's `quotas.storageBytes`
 * LIMIT, which it reads via `GET /quotas/:orgId/storageBytes`. Pooling therefore
 * carves out only the USAGE half for storageBytes — the limit is pooled like
 * every other dimension, because a team's own limit is -1 and the push gate
 * reads that as unlimited. The feature-table counters (dashboards, alertRules,
 * alertDestinations, idpConfigs) are incremented on create and decremented on
 * soft-delete by the platform service; `listings` on publish / unlist.
 */
export type QuotaUsageTracking = Record<QuotaType, QuotaUsage>;

export interface OrganizationDocument extends Document {
  name: string;
  slug: string;
  tier: PlanTier;
  quotas: QuotaLimits;
  usage: QuotaUsageTracking;
  /**
   * ROOT orgs of an org → team pool only: the POOLED usage counter per type —
   * the one number the shared cap is enforced against, moved by a single
   * conditional update on this document so concurrent increments from the root
   * and every team can never jointly overshoot (see `QuotaService.incrementUsage`).
   * Absent until the first pooled increment; absent on teams and flat orgs.
   * Each org's own `usage` keeps counting alongside it, as attribution.
   */
  poolUsage?: Partial<QuotaUsageTracking>;
  /**
   * Org → team hierarchy parent (null = root). Written by the platform service
   * into the shared `organizations` collection; declared here so the quota
   * service can roll usage up to the root for the shared-cap check.
   */
  parentOrgId?: string | null;
  /** Soft-delete marker (written by the platform). A soft-deleted team leaves
   *  the quota pool, matching the platform's live-only subtree. */
  deletedAt?: Date | null;
}

// Schema
//
// SCOPE — this is a SECONDARY Mongoose view over the platform-owned
// `organizations` collection (same `collection: 'organizations'` below). The
// PLATFORM service is the sole authority for org lifecycle: it CREATES every
// real org document and seeds each org's `quotas` limits from its tier at
// creation time. This service never inserts an org: `incrementUsage` on a
// missing org throws `OrgNotFoundError`, and an unprovisioned org's READ is
// synthesized by `buildDefaultOrgQuotaResponse` without touching this schema.
//
// `quotas.*` deliberately has NO Mongoose `default:`. Mongoose applies a path
// default when it HYDRATES a document that lacks the path, and `save()` then
// persists it — so a static default here wrote the DEVELOPER figure into every
// org missing a newly added quota type the first time `update()` or
// `resetUsage()` saved it, pinning a Pro org to Developer's cap, and made the
// hydrated increment read-back report that figure while the filter enforced the
// tier preset. An absent limit is resolved at read time instead, by
// `defaultLimitFor(tier, type)` / `defaultLimitExpr` — the org's TIER preset.
//
// INDEXES — declared to mirror the platform-authoritative model
// (platform/src/models/organization.ts): `parentOrgId` (descendant lookups) is
// indexed in both; `name` is indexed here for this service's admin list sort
// (findAll `.sort({ name: 1 })`) — platform does not declare that one, so its
// boot index-reconcile reports `name_1` as unknown until it does (pinned, with
// every other quota-owned path, by test/organization-schema-drift.test.ts).
// Uniqueness constraints platform owns (e.g.
// `slug` unique) are deliberately NOT redeclared here — a secondary model must
// not fight the authoritative model over the shared collection's unique indexes.

const quotaUsageSchema = new Schema<QuotaUsage>( {
  used: { type: Number, default: 0 },
  // See QuotaUsage.limitAtPeriodStart. No default: absent means "no snapshot",
  // which the status computation reads as the current limit.
  limitAtPeriodStart: { type: Number },
  resetAt: { type: Date, default: () => nextQuotaResetDate(config.quota.resetDays) },
},
{ _id: false },
);

/**
 * A fresh counter for ONE quota type, on that type's own period.
 *
 * Per-type rather than one shared default (`periodDaysFor`): the global
 * window is three days, and `cpuCredits` is monthly. Seeding every counter
 * from the global one gave credits ten resets a month against a cap sized for
 * one — a factor-of-ten error in the customer's favour, and invisible, because
 * a counter that resets too often simply never refuses anything.
 */
const defaultUsageFor = (type: QuotaType) => () => ({
  used: 0,
  resetAt: nextQuotaResetDate(periodDaysFor(type)),
});

const organizationSchema = new Schema<OrganizationDocument>( {
  // Mixed to match the shared `organizations` collection, whose docs are written
  // by the platform service with ObjectId `_id`s (the well-known `'system'` org
  // is a plain string). Declaring `String` here meant `findById('<24hex>')`
  // cast to a string and never matched the ObjectId-keyed docs.
  _id: { type: Schema.Types.Mixed },
  name: { type: String, required: true },
  slug: { type: String, required: true },
  // Org → team hierarchy parent (null = root). Indexed for descendant lookups.
  parentOrgId: { type: String, default: null, index: true },
  // Declared so hierarchy filters on it aren't stripped as unknown paths.
  deletedAt: { type: Date, default: null },
  // Enum derived from api-core's VALID_TIERS so a new tier surfaces here automatically.
  tier: { type: String, enum: [...VALID_TIERS], default: 'developer' },
  // No default — see SCOPE above: an absent limit is the tier preset, resolved at read time.
  quotas: Object.fromEntries(VALID_QUOTA_TYPES.map((t) => [t, { type: Number }])),
  usage: Object.fromEntries(
    VALID_QUOTA_TYPES.map((t) => [t, { type: quotaUsageSchema, default: defaultUsageFor(t) }]),
  ),
  // No default: an absent slot means "pool counter not started", which the
  // pooled increment seeds from the root's own live usage.
  poolUsage: Object.fromEntries(
    VALID_QUOTA_TYPES.map((t) => [t, { type: quotaUsageSchema, default: undefined }]),
  ),
},
{ collection: 'organizations' },
);

// Index on `name` to keep the admin-list endpoint (sorted by name, paginated)
// from full-collection scans as the org count grows.
organizationSchema.index({ name: 1 });

// Model (safe for re-registration in tests)

export const Organization =
  (mongoose.models.Organization as mongoose.Model<OrganizationDocument>) ||
  mongoose.model<OrganizationDocument>('Organization', organizationSchema);
