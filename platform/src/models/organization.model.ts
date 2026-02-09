import { Schema, model, Document, Types } from 'mongoose';
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

/**
 * Organization document interface
 */
export interface IOrganization extends Document {
  name: string;
  slug: string;
  description?: string;
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

const quotaUsageSchema = new Schema<IQuotaUsage>(
  {
    used: { type: Number, default: 0, min: 0 },
    resetAt: { type: Date, default: () => getNextResetDate(config.quota.resetPeriod?.apiCalls || '3days') },
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
        default: () => config.quota.organization.plugins,
        min: -1, // -1 means unlimited
      },
      pipelines: {
        type: Number,
        default: () => config.quota.organization.pipelines,
        min: -1, // -1 means unlimited
      },
      apiCalls: {
        type: Number,
        default: () => config.quota.organization.apiCalls,
        min: -1, // -1 means unlimited
      },
    },
    usage: {
      plugins: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.plugins || '3days') }),
      },
      pipelines: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.pipelines || '3days') }),
      },
      apiCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.apiCalls || '3days') }),
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

  if (!this.usage) {
    this.usage = {
      plugins: { used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.plugins || '3days') },
      pipelines: { used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.pipelines || '3days') },
      apiCalls: { used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.apiCalls || '3days') },
    };
    await this.save();
    return true;
  }

  if (!this.usage[type]) {
    const resetPeriod = config.quota.resetPeriod?.[type] || '3days';
    this.usage[type] = { used: 0, resetAt: getNextResetDate(resetPeriod) };
    await this.save();
    return true;
  }

  if (this.usage[type].resetAt <= now) {
    const resetPeriod = config.quota.resetPeriod?.[type] || '3days';
    this.usage[type].used = 0;
    this.usage[type].resetAt = getNextResetDate(resetPeriod);
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
  const limit = this.quotas?.[type] ?? config.quota.organization[type];
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
  if (!this.usage) {
    this.usage = {
      plugins: { used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.plugins || '3days') },
      pipelines: { used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.pipelines || '3days') },
      apiCalls: { used: 0, resetAt: getNextResetDate(config.quota.resetPeriod?.apiCalls || '3days') },
    };
  }

  if (!this.usage[type]) {
    const resetPeriod = config.quota.resetPeriod?.[type] || '3days';
    this.usage[type] = { used: 0, resetAt: getNextResetDate(resetPeriod) };
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

  const existingOrgs = await (this.constructor as any)
    .find({
      slug: slugRegex,
      _id: { $ne: this._id },
    })
    .select('slug')
    .lean();

  if (existingOrgs.length === 0) {
    this.slug = baseSlug;
  } else {
    const suffixes = existingOrgs.map((org: any) => {
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
