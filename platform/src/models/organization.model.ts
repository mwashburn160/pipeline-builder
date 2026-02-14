import type { QuotaTier } from '@mwashburn160/api-core';
import { Schema, model, Document, Types, Model } from 'mongoose';
import slugify from 'slugify';
import { config } from '../config';

/**
 * Quota usage tracking interface
 */
export interface IQuotaUsage {
  used: number;
  resetAt: Date;
}

/**
 * Quota limits interface
 */
export interface IQuotaLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
}

/**
 * Quota usage interface
 */
export interface IQuotaUsageTracking {
  plugins: IQuotaUsage;
  pipelines: IQuotaUsage;
  apiCalls: IQuotaUsage;
}

export type { QuotaTier };

/**
 * Organization document interface
 */
export interface IOrganization extends Document {
  name: string;
  slug: string;
  description?: string;
  tier: QuotaTier;
  owner: Types.ObjectId;
  members: Types.ObjectId[];
  quotas: IQuotaLimits;
  usage: IQuotaUsageTracking;
  createdAt: Date;
  updatedAt: Date;
  // Methods
  checkQuota(type: 'plugins' | 'pipelines' | 'apiCalls'): { allowed: boolean; used: number; limit: number; remaining: number; resetAt: Date };
  incrementUsage(type: 'plugins' | 'pipelines' | 'apiCalls', amount?: number): Promise<IOrganization>;
  resetUsageIfExpired(type: 'plugins' | 'pipelines' | 'apiCalls'): Promise<boolean>;
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
function getTierResetPeriod(tier: QuotaTier, type: 'plugins' | 'pipelines' | 'apiCalls'): string {
  return config.quota.tier[tier].resetPeriod[type];
}

const quotaUsageSchema = new Schema<IQuotaUsage>(
  {
    used: { type: Number, default: 0, min: 0 },
    resetAt: { type: Date, default: () => getNextResetDate(getTierResetPeriod('developer', 'apiCalls')) },
  },
  { _id: false },
);

const organizationSchema = new Schema<IOrganization>(
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
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
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
    },
  },
  {
    timestamps: true,
    collection: 'organizations',
    _id: false,
  },
);

/**
 * Check if usage should be reset and reset if expired
 */
organizationSchema.methods.resetUsageIfExpired = async function (
  type: 'plugins' | 'pipelines' | 'apiCalls',
): Promise<boolean> {
  const now = new Date();
  const tierKey = (this.tier || 'developer') as QuotaTier;

  if (!this.usage) {
    this.usage = {
      plugins: { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, 'plugins')) },
      pipelines: { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, 'pipelines')) },
      apiCalls: { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, 'apiCalls')) },
    };
    await this.save();
    return true;
  }

  if (!this.usage[type]) {
    this.usage[type] = { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, type)) };
    await this.save();
    return true;
  }

  if (this.usage[type].resetAt <= now) {
    this.usage[type].used = 0;
    this.usage[type].resetAt = getNextResetDate(getTierResetPeriod(tierKey, type));
    await this.save();
    return true;
  }

  return false;
};

/**
 * Check quota for a specific type
 * Returns unlimited if limit is -1
 */
organizationSchema.methods.checkQuota = function (
  type: 'plugins' | 'pipelines' | 'apiCalls',
): { allowed: boolean; used: number; limit: number; remaining: number; resetAt: Date } {
  const tierKey = (this.tier || 'developer') as QuotaTier;
  const tierLimits = config.quota.tier[tierKey];
  const limit = this.quotas?.[type] ?? tierLimits[type];
  const usage = this.usage?.[type] || { used: 0, resetAt: new Date() };
  const now = new Date();

  // Unlimited quota (-1 means unlimited)
  if (limit === -1) {
    return {
      allowed: true,
      used: usage.used,
      limit: -1,
      remaining: -1,
      resetAt: usage.resetAt,
    };
  }

  // Check if reset period has passed
  if (usage.resetAt <= now) {
    return {
      allowed: true,
      used: 0,
      limit,
      remaining: limit,
      resetAt: usage.resetAt,
    };
  }

  const used = usage.used;
  const remaining = Math.max(0, limit - used);
  const allowed = used < limit;

  return { allowed, used, limit, remaining, resetAt: usage.resetAt };
};

/**
 * Increment usage for a specific type
 */
organizationSchema.methods.incrementUsage = async function (
  type: 'plugins' | 'pipelines' | 'apiCalls',
  amount: number = 1,
): Promise<IOrganization> {
  // First, reset if expired
  await this.resetUsageIfExpired(type);

  // Initialize usage if not present
  const tierKey = (this.tier || 'developer') as QuotaTier;
  if (!this.usage) {
    this.usage = {
      plugins: { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, 'plugins')) },
      pipelines: { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, 'pipelines')) },
      apiCalls: { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, 'apiCalls')) },
    };
  }

  if (!this.usage[type]) {
    this.usage[type] = { used: 0, resetAt: getNextResetDate(getTierResetPeriod(tierKey, type)) };
  }

  this.usage[type].used += amount;
  return this.save();
};

/**
 * Generate unique slug from organization name
 */
organizationSchema.pre<IOrganization>('validate', async function () {
  if (!this.isModified('name') && this.slug) return;

  const baseSlug = slugify(this.name, { lower: true, strict: true });
  const slugRegex = new RegExp(`^(${baseSlug})(-[0-9]+)?$`, 'i');

  const existingOrgs = await (this.constructor as Model<IOrganization>)
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
      const lastPart = parseInt(parts[parts.length - 1]);
      return isNaN(lastPart) ? 0 : lastPart;
    });
    const maxSuffix = Math.max(0, ...suffixes);
    this.slug = `${baseSlug}-${maxSuffix + 1}`;
  }

  // Ensure owner is in members
  if (this.owner && !this.members.some(id => id.equals(this.owner))) {
    this.members.push(this.owner);
  }
});

export default model<IOrganization>('Organization', organizationSchema);
