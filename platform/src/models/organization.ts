// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaTier } from '@pipeline-builder/api-core';
import { Schema, model, Document, Types, Model } from 'mongoose';
import slugify from 'slugify';
import { config } from '../config';

/**
 * Quota usage tracking interface
 */
export interface QuotaUsage {
  used: number;
  resetAt: Date;
}

/**
 * Quota limits interface
 */
export interface QuotaLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
  aiCalls: number;
}

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
  description?: string;
  tier: QuotaTier;
  /** Denormalized reference to the owning user. Canonical ownership is in UserOrganization (role: 'owner'). */
  owner: Types.ObjectId;
  quotas: QuotaLimits;
  usage: QuotaUsageTracking;
  aiProviderKeys?: {
    'anthropic'?: string;
    'openai'?: string;
    'google'?: string;
    'xai'?: string;
    'amazon-bedrock'?: string;
  };
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
    case 'hourly':
      return new Date(now.getTime() + 60 * 60 * 1000);
    case 'daily':
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      return tomorrow;
    case 'weekly':
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + (7 - nextWeek.getDay()));
      nextWeek.setHours(0, 0, 0, 0);
      return nextWeek;
    case 'monthly':
    default:
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
      return nextMonth;
  }
}

/** Get the reset period for a quota type from a tier config. */
function getTierResetPeriod(tier: QuotaTier, type: 'plugins' | 'pipelines' | 'apiCalls' | 'aiCalls'): string {
  return config.quota.tier[tier].resetPeriod[type];
}

const quotaUsageSchema = new Schema<QuotaUsage>(
  {
    used: { type: Number, default: 0, min: 0 },
    resetAt: { type: Date, default: () => getNextResetDate(getTierResetPeriod('developer', 'apiCalls')) },
  },
  { _id: false },
);

const organizationSchema = new Schema<OrganizationDocument>(
  {
    _id: {
      type: Schema.Types.Mixed,
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
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    tier: {
      type: String,
      enum: ['developer', 'pro', 'unlimited'],
      default: 'developer',
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    quotas: {
      plugins: {
        type: Number,
        default: () => config.quota.tier.developer.plugins,
        min: -1, // -1 means unlimited
      },
      pipelines: {
        type: Number,
        default: () => config.quota.tier.developer.pipelines,
        min: -1, // -1 means unlimited
      },
      apiCalls: {
        type: Number,
        default: () => config.quota.tier.developer.apiCalls,
        min: -1, // -1 means unlimited
      },
      aiCalls: {
        type: Number,
        default: () => config.quota.tier.developer.aiCalls,
        min: -1, // -1 means unlimited
      },
    },
    usage: {
      plugins: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod('developer', 'plugins')) }),
      },
      pipelines: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod('developer', 'pipelines')) }),
      },
      apiCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod('developer', 'apiCalls')) }),
      },
      aiCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(getTierResetPeriod('developer', 'aiCalls')) }),
      },
    },
    aiProviderKeys: {
      'anthropic': { type: String, default: undefined },
      'openai': { type: String, default: undefined },
      'google': { type: String, default: undefined },
      'xai': { type: String, default: undefined },
      'amazon-bedrock': { type: String, default: undefined },
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
