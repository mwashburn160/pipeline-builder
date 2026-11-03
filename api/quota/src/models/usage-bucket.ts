// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PRINCIPAL_TYPES, VALID_QUOTA_TYPES, type PrincipalType, type QuotaType } from '@pipeline-builder/api-core';
import mongoose, { Schema } from 'mongoose';
import { USAGE_OUTCOMES, type UsageOutcome } from './usage-event.js';
import { config } from '../config.js';

/**
 * One HOURLY bucket of the usage ledger: how many units of one quota, with one
 * outcome, one org spent through one (principal, key, route, pipeline) in one
 * UTC hour. Written by `$inc` upsert (services/usage-ledger.ts), so a burst of
 * 10,000 calls from one key on one route is one document, not 10,000.
 *
 * The bucket key is every field below except `rootOrgId` and `amount`; the
 * unique index enforces it, so concurrent upserts from several replicas
 * converge on one document. Absent attribution is stored as `null` (the upsert
 * filter matches on `null`, which also matches a missing field).
 *
 * SIZING. Documents per org per hour = the number of DISTINCT active
 * (principal × key × route × pipeline × outcome) combinations that hour — in
 * practice the count of routes a team's people and keys actually touched, not
 * the request count. A busy account with 50 active combinations is
 * 50 × 24 × 90 ≈ 108k documents over the default 90-day retention, at
 * ~300 bytes each ≈ 32 MB, whatever its request volume. The per-call
 * collection it replaces grew linearly with requests (1M calls ≈ 1M documents).
 *
 * Retention: TTL on `hour` (`QUOTA_USAGE_EVENT_RETENTION_DAYS`, default 90 —
 * shared with the raw exception rows). Fresh-install DDL, like every TTL index:
 * changing the env on a live install needs `hour_1` dropped and rebuilt.
 */
export interface UsageBucketDocument {
  orgId: string;
  /** The account (pool root) at the time of the latest write. */
  rootOrgId: string;
  quotaType: QuotaType;
  outcome: UsageOutcome;
  principalType: PrincipalType | null;
  principalId: string | null;
  keyId: string | null;
  route: string | null;
  pipelineId: string | null;
  /** Start of the UTC hour. */
  hour: Date;
  /** Units summed into this bucket. */
  amount: number;
}

const usageBucketSchema = new Schema<UsageBucketDocument>({
  orgId: { type: String, required: true },
  rootOrgId: { type: String, required: true },
  quotaType: { type: String, enum: [...VALID_QUOTA_TYPES], required: true },
  outcome: { type: String, enum: [...USAGE_OUTCOMES], required: true },
  principalType: { type: String, enum: [...PRINCIPAL_TYPES, null], default: null },
  principalId: { type: String, default: null },
  keyId: { type: String, default: null },
  route: { type: String, default: null },
  pipelineId: { type: String, default: null },
  hour: { type: Date, required: true },
  amount: { type: Number, required: true, default: 0 },
}, { collection: 'quota_usage_buckets', versionKey: false });

// The bucket key. Led by (orgId, hour), so it doubles as the TEAM read scope's
// index: `{ orgId, hour: range }` with or without a quota type.
usageBucketSchema.index(
  { orgId: 1, hour: 1, quotaType: 1, outcome: 1, principalType: 1, principalId: 1, keyId: 1, route: 1, pipelineId: 1 },
  { unique: true, name: 'bucket_key' },
);
// The ACCOUNT read scope: `{ rootOrgId, hour: range }`, any quota type. Not led
// by quotaType on purpose — a type-less read ("everything this account used")
// must not scan every type's buckets.
usageBucketSchema.index({ rootOrgId: 1, hour: -1 });
// Retention.
usageBucketSchema.index({ hour: 1 }, { expireAfterSeconds: config.quota.usageEventRetentionDays * 86_400 });

export const UsageBucket =
  (mongoose.models.QuotaUsageBucket as mongoose.Model<UsageBucketDocument>) ||
  mongoose.model<UsageBucketDocument>('QuotaUsageBucket', usageBucketSchema);
