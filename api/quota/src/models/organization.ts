// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { VALID_QUOTA_TYPES, VALID_TIERS, type QuotaTier, type QuotaType, nextQuotaResetDate } from '@pipeline-builder/api-core';
import mongoose, { Schema, Document } from 'mongoose';
import { config } from '../config.js';

// Types

interface QuotaUsage {
  used: number;
  resetAt: Date;
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
  tier: QuotaTier;
  quotas: QuotaLimits;
  usage: QuotaUsageTracking;
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
// creation time. This schema (and the `config.quota.defaults` / `QUOTA_DEFAULT_*`
// env it sources its field defaults from) is therefore consulted for enforcement
// ONLY via the stored `quotas` values platform wrote — the Mongoose-level
// `default:` on each `quotas.*`/`usage.*` field below is DEAD for real orgs (they
// always arrive already-populated) and matters solely for two paths:
//   1. `buildDefaultOrgQuotaResponse` — the unprovisioned-org fallback READ in
//      quota-service.findByOrgId (org absent → synthesize a developer-tier
//      response so the dashboard renders). This never writes a document.
//   2. A brand-new field platform hasn't backfilled yet (schema-migration seam).
// It does NOT drive quota ENFORCEMENT: `incrementUsage` reserves against the
// STORED `quotas.<type>` platform seeded, and on a missing org it throws
// `OrgNotFoundError` rather than inserting defaults. So `QUOTA_DEFAULT_*` govern
// the fallback read only, not the cap an org is actually held to.
//
// INDEXES — declared to mirror the platform-authoritative model
// (platform/src/models/organization.ts): `parentOrgId` (descendant lookups) is
// indexed in both; `name` is indexed here for this service's admin list sort
// (findAll `.sort({ name: 1 })`). Uniqueness constraints platform owns (e.g.
// `slug` unique) are deliberately NOT redeclared here — a secondary model must
// not fight the authoritative model over the shared collection's unique indexes.

const quotaUsageSchema = new Schema<QuotaUsage>( {
  used: { type: Number, default: 0 },
  resetAt: { type: Date, default: () => nextQuotaResetDate(config.quota.resetDays) },
},
{ _id: false },
);

const defaultUsage = () => ({ used: 0, resetAt: nextQuotaResetDate(config.quota.resetDays) });

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
  quotas: Object.fromEntries(
    VALID_QUOTA_TYPES.map((t) => [t, { type: Number, default: config.quota.defaults[t] }]),
  ),
  usage: Object.fromEntries(
    VALID_QUOTA_TYPES.map((t) => [t, { type: quotaUsageSchema, default: defaultUsage }]),
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
