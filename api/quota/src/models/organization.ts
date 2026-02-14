/**
 * @module models/organization
 * @description Mongoose schema and model for organizations with quota tracking.
 */

import type { QuotaTier } from '@mwashburn160/api-core';
import mongoose, { Schema, Document } from 'mongoose';
import { config } from '../config';
import { getNextResetDate } from '../helpers/quota-helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotaUsage {
  used: number;
  resetAt: Date;
}

export interface QuotaLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
}

export interface QuotaUsageTracking {
  plugins: QuotaUsage;
  pipelines: QuotaUsage;
  apiCalls: QuotaUsage;
}

export type { QuotaTier };

export interface IOrganization extends Document {
  _id: string;
  name: string;
  slug: string;
  tier: QuotaTier;
  quotas: QuotaLimits;
  usage: QuotaUsageTracking;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const quotaUsageSchema = new Schema<QuotaUsage>(
  {
    used: { type: Number, default: 0 },
    resetAt: { type: Date, default: () => getNextResetDate(config.quota.resetDays) },
  },
  { _id: false },
);

const defaultUsage = () => ({ used: 0, resetAt: getNextResetDate(config.quota.resetDays) });

const organizationSchema = new Schema<IOrganization>(
  {
    _id: { type: Schema.Types.Mixed },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    tier: { type: String, enum: ['developer', 'pro', 'unlimited'], default: 'developer' },
    quotas: {
      plugins: { type: Number, default: config.quota.defaults.plugins },
      pipelines: { type: Number, default: config.quota.defaults.pipelines },
      apiCalls: { type: Number, default: config.quota.defaults.apiCalls },
    },
    usage: {
      plugins: { type: quotaUsageSchema, default: defaultUsage },
      pipelines: { type: quotaUsageSchema, default: defaultUsage },
      apiCalls: { type: quotaUsageSchema, default: defaultUsage },
    },
  },
  { collection: 'organizations' },
);

// ---------------------------------------------------------------------------
// Model (safe for re-registration in tests)
// ---------------------------------------------------------------------------

export const Organization =
  (mongoose.models.Organization as mongoose.Model<IOrganization>) ||
  mongoose.model<IOrganization>('Organization', organizationSchema);
