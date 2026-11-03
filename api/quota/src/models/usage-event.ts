// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PRINCIPAL_TYPES, VALID_QUOTA_TYPES, type PrincipalType, type QuotaType } from '@pipeline-builder/api-core';
import mongoose, { Schema } from 'mongoose';
import { config } from '../config.js';

/**
 * What happened to the units an event describes:
 *  - `counted`   — the increment / reservation landed;
 *  - `denied`    — a RESERVATION refused at the limit (QUOTA_EXCEEDED): the
 *                  gated action did not run and the counter did not move;
 *  - `overshoot` — METERED units (apiCalls / automationCalls) for requests that
 *                  were already SERVED but did not fit under the cap when the
 *                  pod's batch landed (the check cache let them through, or they
 *                  raced the last unit). Not counted — the counter never passes
 *                  the cap — but they happened, unlike a denial;
 *  - `refunded`  — a reservation was given back (decrement).
 */
export const USAGE_OUTCOMES = ['counted', 'denied', 'overshoot', 'refunded'] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

/**
 * One RAW row of the usage ledger — kept ONLY for the exceptional outcomes
 * (`denied`, `overshoot`, `refunded`), where the individual event (its request
 * id, the exact minute) is what someone disputing a 429 or a refund asks for.
 *
 * Counted usage is NOT recorded per call any more: one document per metered
 * request was the quota service's largest write load and its largest
 * collection, for data every read immediately summed. Every outcome —
 * including these — is aggregated into hourly {@link UsageBucket}s, which the
 * "what used this" breakdown and its CSV export read
 * (`GET /quotas/:orgId/usage`). Enforcement never reads either, and a failed
 * write never fails the increment it describes
 * (`quota_usage_event_write_failed_total`).
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
// Forensic reads ("which requests were refused on Tuesday"): a whole account by
// its root, one team by its own id, newest-first — with or without a quota type
// (an index led by quotaType made the type-less read a collection scan).
usageEventSchema.index({ rootOrgId: 1, at: -1 });
usageEventSchema.index({ orgId: 1, at: -1 });

export const UsageEvent =
  (mongoose.models.QuotaUsageEvent as mongoose.Model<UsageEventDocument>) ||
  mongoose.model<UsageEventDocument>('QuotaUsageEvent', usageEventSchema);
