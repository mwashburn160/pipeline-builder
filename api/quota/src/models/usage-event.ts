// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PRINCIPAL_TYPES, VALID_QUOTA_TYPES, type PrincipalType, type QuotaType } from '@pipeline-builder/api-core';
import mongoose, { Schema } from 'mongoose';
import { config } from '../config.js';

/**
 * What happened to the units an event describes:
 *  - `counted`  — the increment / reservation landed;
 *  - `denied`   — refused at the limit (QUOTA_EXCEEDED). The counter did NOT
 *                 move, so this is the only place a refused attempt is visible;
 *  - `refunded` — a reservation was given back (decrement).
 */
export const USAGE_OUTCOMES = ['counted', 'denied', 'refunded'] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

/**
 * One row of the USAGE LEDGER: who spent (or got back) how many units of which
 * quota, through which route, for which pipeline.
 *
 * The aggregate counter on the organizations doc says HOW MUCH an org used; this
 * says WHAT used it — the "what used this" breakdown and its CSV export
 * (`GET /quotas/:orgId/usage`). Enforcement never reads it, and a failed write
 * never fails the increment it describes (`quota_usage_event_write_failed_total`).
 *
 * Retention is a TTL index on `at` (`QUOTA_USAGE_EVENT_RETENTION_DAYS`, default
 * 90). Fresh-install DDL: Mongo will not change an existing TTL index's
 * `expireAfterSeconds` in place, so changing the env on a live install needs the
 * `at_1` index dropped and rebuilt.
 */
export interface UsageEventDocument {
  orgId: string;
  /** The account (pool root); equals `orgId` for a flat org or the root itself. */
  rootOrgId: string;
  quotaType: QuotaType;
  amount: number;
  principalType?: PrincipalType;
  /** User id or service-account id. */
  principalId?: string;
  keyId?: string;
  /** `METHOD /route/:pattern`. */
  route?: string;
  pipelineId?: string;
  requestId?: string;
  outcome: UsageOutcome;
  at: Date;
}

const usageEventSchema = new Schema<UsageEventDocument>({
  orgId: { type: String, required: true },
  rootOrgId: { type: String, required: true },
  quotaType: { type: String, enum: [...VALID_QUOTA_TYPES], required: true },
  amount: { type: Number, required: true },
  principalType: { type: String, enum: [...PRINCIPAL_TYPES] },
  principalId: String,
  keyId: String,
  route: String,
  pipelineId: String,
  requestId: String,
  outcome: { type: String, enum: [...USAGE_OUTCOMES], required: true },
  at: { type: Date, required: true, default: Date.now },
}, { collection: 'quota_usage_events', versionKey: false });

// Retention.
usageEventSchema.index({ at: 1 }, { expireAfterSeconds: config.quota.usageEventRetentionDays * 86_400 });
// The two read scopes (see `queryUsage`): a whole account by its root, one team
// by its own id — each narrowed by type and walked newest-first by time.
usageEventSchema.index({ rootOrgId: 1, quotaType: 1, at: -1 });
usageEventSchema.index({ orgId: 1, quotaType: 1, at: -1 });

export const UsageEvent =
  (mongoose.models.QuotaUsageEvent as mongoose.Model<UsageEventDocument>) ||
  mongoose.model<UsageEventDocument>('QuotaUsageEvent', usageEventSchema);
