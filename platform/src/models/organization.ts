// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, QUOTA_TIERS, type QuotaTier, type QuotaTierLimits, VALID_TIERS } from '@pipeline-builder/api-core';
import { Schema, model, Document, Types, Model } from 'mongoose';
import slugify from 'slugify';
import { config } from '../config/index.js';

/**
 * Quota usage tracking interface
 */
export interface QuotaUsage {
  used: number;
  resetAt: Date;
}

/**
 * Quota limits interface.
 *
 * Aliased to api-core's `QuotaTierLimits` so the schema, the in-memory
 * preset tables, and every consumer stay in lockstep — adding a new
 * countable resource in `QUOTA_TIERS` surfaces a compile error in the
 * schema-defaults block below.
 */
export type QuotaLimits = QuotaTierLimits;

/**
 * Quota usage interface
 */
export interface QuotaUsageTracking {
  plugins: QuotaUsage;
  pipelines: QuotaUsage;
  apiCalls: QuotaUsage;
  aiCalls: QuotaUsage;
}

export type { QuotaTier };

/**
 * Organization document interface.
 *
 * Organizations no longer embed a `members[]` array. Membership is managed
 * through the {@link UserOrganization} junction collection, which stores
 * per-org roles ('owner' | 'admin' | 'member') and an `isActive` flag.
 *
 * To list members of an organization, query `UserOrganization` by `organizationId`.
 * The `owner` field here is kept as a denormalized reference to the owning user.
 */
export interface OrganizationDocument extends Document {
  name: string;
  slug: string;
  /** True for the single well-known system tenant (id = api-core SYSTEM_ORG_ID).
   *  Identifies the system org by flag rather than a magic string `_id`. */
  isSystem?: boolean;
  description?: string;
  tier: QuotaTier;
  /** Account-level purchased feature entitlements (bundles), synced by billing
   *  to the root and propagated onto teams. */
  featureEntitlements: string[];
  /** Denormalized reference to the owning user. Canonical ownership is in UserOrganization (role: 'owner'). */
  owner: Types.ObjectId;
  /**
   * Parent organization id for the org → team hierarchy (org-team-hierarchy
   * proposal, phase 1). `null`/absent = a **root** organization; a non-null
   * value makes this org a "team" nested under its parent. Stored as a string
   * id (org `_id`s may be ObjectId or string, e.g. the well-known `'system'`
   * org), so the descendant-expansion helper matches on string ids.
   * No org sets this today — the column is the additive foundation.
   */
  parentOrgId?: string | null;
  quotas: QuotaLimits;
  usage: QuotaUsageTracking;
  aiProviderKeys?: {
    'anthropic'?: string;
    'openai'?: string;
    'google'?: string;
    'xai'?: string;
    'amazon-bedrock'?: string;
  };
  /**
   * Per-org AWS IAM role for build / runtime AWS API calls. When set,
   * services that need AWS credentials for this org call `sts:AssumeRole`
   * on this ARN instead of using the service's shared role — limits the
   * blast radius of an org compromise to one customer's AWS account.
   *
   * The role's trust policy MUST require this `externalId` so a leaked
   * RoleArn alone can't be assumed by a third party (AWS "confused deputy"
   * mitigation). Operators configure this via the admin org endpoint;
   * orgs without an entry continue to use the service's shared role.
   */
  awsConfig?: {
    assumeRoleArn?: string;
    externalId?: string;
    region?: string;
    sessionDurationSeconds?: number;
  };
  /**
   * Per-org KMS configuration. When set, this org's secrets (AI provider
   * keys, IdP client secrets, …) are wrapped under THIS org's KMS CMK
   * instead of the shared master key — a CMK compromise has blast radius
   * of one org, not the whole fleet.
   *
   * Operator setup (per org):
   *   1. Create a KMS CMK with key policy allowing platform's IAM role
   *      `kms:Decrypt`.
   *   2. Generate a 32-byte master:     `head -c 32 /dev/urandom | base64`
   *   3. Wrap with KMS:                 `aws kms encrypt --key-id <KEY> --plaintext <b64>`
   *   4. Store `{ keyId, ciphertextBase64 }` in this field via the admin API.
   * Orgs without an entry fall through to the shared master (mixed-mode
   * deployments are explicitly supported).
   */
  kmsConfig?: {
    keyId?: string;
    ciphertextBase64?: string;
  };
  /**
   * Durable "paid-signup billing bootstrap still pending" marker. Set when a
   * new org selected a paid `planId` at signup but the fire-and-forget billing
   * subscription call couldn't be provisioned (billing down/unreachable, all
   * retries exhausted). The reconcile pass ({@link reconcilePendingBillingSubscriptions})
   * retries every org carrying this marker and clears it once billing actually
   * provisions the subscription — closing the fail-open gap where an org would
   * otherwise stay silently developer-tier with no bill.
   *
   * NOT a local tier grant: the org's `tier` is untouched until billing
   * provisions it (no free-paid-tier). The marker only guarantees the
   * provisioning eventually happens (or is visible to an operator).
   */
  pendingBillingPlanId?: string;
  /** When {@link pendingBillingPlanId} was first set (marker age, for operators). */
  pendingBillingSince?: Date;
  /**
   * SOFT-DELETE tombstone. Set (with {@link purgeAfter}) when a sysadmin runs
   * `DELETE /organization/:id`: instead of the immediate destructive cascade the
   * org enters a retention window. `null`/absent = a live org. Access is cut off
   * at the token chokepoint (`resolveMembership` refuses to scope a token to a
   * soft-deleted org) + a tokenVersion bump on every member, NOT via per-read
   * `deletedAt` filters. Sparse-indexed so the purge sweep's scan is cheap
   * (only tombstoned docs carry it).
   */
  deletedAt?: Date | null;
  /**
   * When the purge sweep may run the destructive cascade for this soft-deleted
   * org (= `deletedAt` + `organization.deletionRetentionDays`). Until then a
   * sysadmin/owner can restore. Sparse-indexed for the sweep's
   * `{ purgeAfter: { $lte: now } }` scan.
   */
  purgeAfter?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get next reset date based on reset period
 * Supports: hourly, daily, weekly, monthly, or Ndays (e.g. '3days', '7days')
 */
function getNextResetDate(resetPeriod: string): Date {
  const now = new Date();

  // Check for custom day period (e.g. '3days', '7days')
  const dayMatch = resetPeriod.match(/^(\d+)days?$/i);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    const future = new Date(now);
    future.setDate(future.getDate() + days);
    future.setHours(0, 0, 0, 0);
    return future;
  }

  switch (resetPeriod) {
    case 'hourly': {
      return new Date(now.getTime() + 60 * 60 * 1000);
    }
    case 'daily': {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      return tomorrow;
    }
    case 'weekly': {
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + (7 - nextWeek.getDay()));
      nextWeek.setHours(0, 0, 0, 0);
      return nextWeek;
    }
    case 'monthly':
    default: {
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
      return nextMonth;
    }
  }
}

/** Get the reset period for a quota type from a tier config. */
function getTierResetPeriod(tier: QuotaTier, type: 'plugins' | 'pipelines' | 'apiCalls' | 'aiCalls'): string {
  return config.quota.tier[tier].resetPeriod[type];
}

const quotaUsageSchema = new Schema<QuotaUsage>(
  {
    used: { type: Number, default: 0, min: 0 },
    resetAt: { type: Date, default: () => getNextResetDate(getTierResetPeriod(DEFAULT_TIER, 'apiCalls')) },
  },
  { _id: false },
);

const organizationSchema = new Schema<OrganizationDocument>(
  {
    _id: {
      type: Schema.Types.ObjectId,
      default: () => new Types.ObjectId(),
    },
    name: {
      type: String,
      required: [true, 'Organization name is required'],
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    isSystem: {
      type: Boolean,
      default: false,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    tier: {
      type: String,
      // Drive the Mongoose enum from api-core's `VALID_TIERS` tuple so adding
      // a tier in api-core surfaces here automatically (no string drift
      // between the type and the schema).
      enum: VALID_TIERS as unknown as string[],
      // Default to the operator-configured DEFAULT_QUOTA_TIER (api-core resolves
      // it from env; falls back to 'developer'). Quota defaults below track the
      // same tier so a new org's tier and seeded limits stay consistent.
      default: DEFAULT_TIER,
    },
    // Account-level feature entitlements purchased via bundles (audit_log/sso).
    // Billing syncs these to the ROOT org; unioned into `resolveUserFeatures`.
    featureEntitlements: {
      type: [String],
      default: [],
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Org → team hierarchy parent (null = root). Stored as a string id and
    // indexed so descendant lookups (`{ parentOrgId: { $in: [...] } }`) are
    // cheap. See helpers/org-hierarchy.ts.
    parentOrgId: {
      type: String,
      default: null,
      index: true,
    },
    // Defaults sourced from `QUOTA_TIERS[DEFAULT_TIER].limits` (the
    // DEFAULT_QUOTA_TIER preset) so every countable resource in `QuotaTierLimits` is here
    // without hand-syncing values. Adding a new limit in api-core surfaces
    // a missing-field compile error on the `quotas: QuotaLimits` interface
    // (because `QuotaLimits = QuotaTierLimits`).
    quotas: {
      plugins: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.plugins,
        min: -1, // -1 means unlimited
      },
      pipelines: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.pipelines,
        min: -1,
      },
      apiCalls: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.apiCalls,
        min: -1,
      },
      aiCalls: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.aiCalls,
        min: -1,
      },
      // Aggregate registry storage cap (bytes). Enforced by the
      // image-registry push-gate.
      storageBytes: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.storageBytes,
        min: -1,
      },
      // Per-org count caps on user-editable feature tables. -1 means unlimited.
      dashboards: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.dashboards,
        min: -1,
      },
      alertRules: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.alertRules,
        min: -1,
      },
      alertDestinations: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.alertDestinations,
        min: -1,
      },
      idpConfigs: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.idpConfigs,
        min: -1,
      },
      // Max org members. NOT usage-tracked (no counter) — enforced live at
      // invite time by counting members + pending invites. Stored as the org's
      // limit so per-org overrides via the quota CRUD API work like any limit.
      seats: {
        type: Number,
        default: () => QUOTA_TIERS[DEFAULT_TIER].limits.seats,
        min: -1,
      },
    },
    usage: {
      plugins: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod(DEFAULT_TIER, 'plugins')) }),
      },
      pipelines: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod(DEFAULT_TIER, 'pipelines')) }),
      },
      apiCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod(DEFAULT_TIER, 'apiCalls')) }),
      },
      aiCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod(DEFAULT_TIER, 'aiCalls')) }),
      },
    },
    aiProviderKeys: {
      'anthropic': { type: String, default: undefined },
      'openai': { type: String, default: undefined },
      'google': { type: String, default: undefined },
      'xai': { type: String, default: undefined },
      'amazon-bedrock': { type: String, default: undefined },
    },
    awsConfig: {
      assumeRoleArn: { type: String, default: undefined },
      externalId: { type: String, default: undefined },
      region: { type: String, default: undefined },
      // 900-43200 are the AWS-allowed bounds; effective cap is also the
      // role's MaxSessionDuration. We don't enforce the upper bound here
      // because operators occasionally need long sessions for batch jobs.
      sessionDurationSeconds: { type: Number, default: undefined, min: 900 },
    },
    kmsConfig: {
      keyId: { type: String, default: undefined },
      // The base64-wrapped 32-byte master. Safe to store at rest — it can
      // only be decrypted by an identity with kms:Decrypt on `keyId`.
      ciphertextBase64: { type: String, default: undefined },
    },
    // Durable paid-signup billing-bootstrap marker (see interface docs). Indexed
    // so the reconcile pass's `{ pendingBillingPlanId: { $exists: true, $ne: null } }`
    // scan is a cheap targeted lookup (sparse — only failed bootstraps carry it).
    pendingBillingPlanId: {
      type: String,
      default: undefined,
      index: { sparse: true },
    },
    pendingBillingSince: {
      type: Date,
      default: undefined,
    },
    // Soft-delete tombstone + purge deadline (see interface docs). Both sparse-
    // indexed so the purge sweep's `{ deletedAt: { $ne: null }, purgeAfter: { $lte } }`
    // scan touches only the (few) tombstoned docs, not every org.
    deletedAt: {
      type: Date,
      default: null,
      index: { sparse: true },
    },
    purgeAfter: {
      type: Date,
      default: null,
      index: { sparse: true },
    },
  },
  {
    timestamps: true,
    collection: 'organizations',
    _id: false,
  },
);

/**
 * Generate unique slug from organization name
 */
organizationSchema.pre<OrganizationDocument>('validate', async function () {
  // An explicitly-set slug (self-serve identity edit) always wins — never
  // overwrite it with the name-derived auto-slug, even when the name also
  // changed in the same save.
  if (this.isModified('slug') && this.slug) return;
  if (!this.isModified('name') && this.slug) return;

  const baseSlug = slugify(this.name, { lower: true, strict: true });
  const slugRegex = new RegExp(`^(${baseSlug})(-[0-9]+)?$`, 'i');

  const existingOrgs = await (this.constructor as Model<OrganizationDocument>)
    .find({
      slug: slugRegex,
      _id: { $ne: this._id },
    })
    .select('slug')
    .lean();

  if (existingOrgs.length === 0) {
    this.slug = baseSlug;
  } else {
    const suffixes = existingOrgs.map((org: { slug: string }) => {
      const parts = org.slug.split('-');
      const lastPart = parseInt(parts[parts.length - 1], 10);
      return isNaN(lastPart) ? 0 : lastPart;
    });
    const maxSuffix = Math.max(0, ...suffixes);
    this.slug = `${baseSlug}-${maxSuffix + 1}`;
  }

});

export default model<OrganizationDocument>('Organization', organizationSchema);
