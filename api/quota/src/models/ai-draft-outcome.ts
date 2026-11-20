// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema } from 'mongoose';
import { config } from '../config.js';
import { AI_DRAFT_FEATURES, AI_DRAFT_OUTCOMES, type AiDraftFeature, type AiDraftOutcome } from '../services/ai-draft-catalog.js';

/**
 * One HOURLY bucket of AI-draft outcomes: how many AI-generated drafts one org
 * accepted, edited-then-accepted or discarded, for one feature, in one UTC
 * hour. Written by `$inc` upsert (services/ai-usage-report.ts) from the Ask
 * agent's `POST /ask-agent/draft-outcome`, and read by the AI assistant usage
 * report (`GET /quotas/:orgId/ai-usage`) for its acceptance rate.
 *
 * WHAT IS STORED is the whole contract: org, feature, outcome, hour, count.
 * No user id, no principal, no prompt, no draft content — an acceptance rate is
 * a property of the feature and the team, never of a person. The write path
 * carries nothing else, so nothing else can leak into a report.
 *
 * Why here, beside the usage ledger: the report divides one by the other per
 * bucket, so both live in the same store, under the same scope rule
 * (`rootOrgId` ∪ `orgId`), the same hourly granularity and the same retention.
 * An audit row would carry the actor (a person); a Postgres reporting table
 * would put the two halves of one ratio in two databases.
 *
 * Retention: TTL on `hour` (`QUOTA_USAGE_EVENT_RETENTION_DAYS`, shared with the
 * ledger). Fresh-install DDL, like every TTL index.
 */
export interface AiDraftOutcomeBucketDocument {
  orgId: string;
  /** The account (pool root) at the time of the latest write. */
  rootOrgId: string;
  /** Start of the UTC hour. */
  hour: Date;
  feature: AiDraftFeature;
  outcome: AiDraftOutcome;
  count: number;
}

const aiDraftOutcomeBucketSchema = new Schema<AiDraftOutcomeBucketDocument>({
  orgId: { type: String, required: true },
  rootOrgId: { type: String, required: true },
  hour: { type: Date, required: true },
  feature: { type: String, enum: [...AI_DRAFT_FEATURES], required: true },
  outcome: { type: String, enum: [...AI_DRAFT_OUTCOMES], required: true },
  count: { type: Number, required: true, default: 0 },
}, { collection: 'ai_draft_outcome_buckets', versionKey: false });

// The bucket key, led by (orgId, hour): also the own-org read scope's index.
aiDraftOutcomeBucketSchema.index({ orgId: 1, hour: 1, feature: 1, outcome: 1 }, { unique: true, name: 'bucket_key' });
// The account (rollup) read scope.
aiDraftOutcomeBucketSchema.index({ rootOrgId: 1, hour: -1 });
// Retention.
aiDraftOutcomeBucketSchema.index({ hour: 1 }, { expireAfterSeconds: config.quota.usageEventRetentionDays * 86_400 });

export const AiDraftOutcomeBucket =
  (mongoose.models.AiDraftOutcomeBucket as mongoose.Model<AiDraftOutcomeBucketDocument>) ||
  mongoose.model<AiDraftOutcomeBucketDocument>('AiDraftOutcomeBucket', aiDraftOutcomeBucketSchema);
