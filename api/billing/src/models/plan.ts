/**
 * @module models/plan
 * @description Mongoose schema and model for billing plans.
 */

import type { QuotaTier } from '@mwashburn160/api-core';
import mongoose, { Schema, Document } from 'mongoose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanPrices {
  monthly: number;
  annual: number;
}

export interface IPlan extends Document<string> {
  _id: string;
  name: string;
  description: string;
  tier: QuotaTier;
  prices: PlanPrices;
  features: string[];
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const planSchema = new Schema<IPlan>(
  {
    _id: { type: Schema.Types.Mixed },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    tier: { type: String, enum: ['developer', 'pro', 'unlimited'], required: true },
    prices: {
      monthly: { type: Number, required: true, default: 0 },
      annual: { type: Number, required: true, default: 0 },
    },
    features: [{ type: String }],
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  {
    collection: 'plans',
    timestamps: true,
  },
);

// ---------------------------------------------------------------------------
// Model (safe for re-registration in tests)
// ---------------------------------------------------------------------------

export const Plan =
  (mongoose.models.Plan as mongoose.Model<IPlan>) ||
  mongoose.model<IPlan>('Plan', planSchema);
