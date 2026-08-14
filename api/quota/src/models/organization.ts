// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { VALID_TIERS, type QuotaTier } from '@pipeline-builder/api-core';
import mongoose, { Schema, Document } from 'mongoose';
import { config } from '../config.js';
import { getNextResetDate } from '../helpers/quota-helpers.js';

// Types

export interface QuotaUsage {
  used: number;
  resetAt: Date;
}

export interface QuotaLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
  aiCalls: number;
  /** Aggregate registry storage cap in bytes. -1 means unlimited. */
  storageBytes: number;
  /** Count caps on the user-editable feature tables (close DoS spam). */
  dashboards: number;
  alertRules: number;
  alertDestinations: number;
  idpConfigs: number;
}

export interface QuotaUsageTracking {
  plugins: QuotaUsage;
  pipelines: QuotaUsage;
  apiCalls: QuotaUsage;
  aiCalls: QuotaUsage;
  /**
   * Measured registry storage usage in bytes. Unlike the other usage
   * fields (which `incrementUsage` bumps as actions land), this is set by
   * the image-registry's GC scheduler / push path via the existing
   * `incrementUsage` + `decrementUsage` flows  push reserves an increment,
   * GC freeing bytes reduces it via resetUsage. The image-registry caches
   * the rollup for 60s (see storage-usage.ts) so the value can lag the
   * registry's true state briefly without causing oscillation.
   */
  storageBytes: QuotaUsage;
  /** Per-feature-table counters — incremented on create, decremented on
   *  soft-delete in the platform service. */
  dashboards: QuotaUsage;
  alertRules: QuotaUsage;
  alertDestinations: QuotaUsage;
  idpConfigs: QuotaUsage;
}

export type { QuotaTier };

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
  resetAt: { type: Date, default: () => getNextResetDate(config.quota.resetDays) },
},
{ _id: false },
);

const defaultUsage = () => ({ used: 0, resetAt: getNextResetDate(config.quota.resetDays) });

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
  // Enum derived from api-core's VALID_TIERS so a new tier surfaces here automatically.
  tier: { type: String, enum: [...VALID_TIERS], default: 'developer' },
  quotas: {
    plugins: { type: Number, default: config.quota.defaults.plugins },
    pipelines: { type: Number, default: config.quota.defaults.pipelines },
    apiCalls: { type: Number, default: config.quota.defaults.apiCalls },
    aiCalls: { type: Number, default: config.quota.defaults.aiCalls },
    storageBytes: { type: Number, default: config.quota.defaults.storageBytes },
    dashboards: { type: Number, default: config.quota.defaults.dashboards },
    alertRules: { type: Number, default: config.quota.defaults.alertRules },
    alertDestinations: { type: Number, default: config.quota.defaults.alertDestinations },
    idpConfigs: { type: Number, default: config.quota.defaults.idpConfigs },
  },
  usage: {
    plugins: { type: quotaUsageSchema, default: defaultUsage },
    pipelines: { type: quotaUsageSchema, default: defaultUsage },
    apiCalls: { type: quotaUsageSchema, default: defaultUsage },
    aiCalls: { type: quotaUsageSchema, default: defaultUsage },
    storageBytes: { type: quotaUsageSchema, default: defaultUsage },
    dashboards: { type: quotaUsageSchema, default: defaultUsage },
    alertRules: { type: quotaUsageSchema, default: defaultUsage },
    alertDestinations: { type: quotaUsageSchema, default: defaultUsage },
    idpConfigs: { type: quotaUsageSchema, default: defaultUsage },
  },
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
