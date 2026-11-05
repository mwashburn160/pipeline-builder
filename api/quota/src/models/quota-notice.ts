// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { VALID_QUOTA_TYPES, type QuotaType } from '@pipeline-builder/api-core';
import mongoose, { Schema } from 'mongoose';

/** The usage percentages a threshold notice fires at. */
export const QUOTA_NOTICE_THRESHOLDS = [80, 100] as const;
export type QuotaNoticeThreshold = (typeof QUOTA_NOTICE_THRESHOLDS)[number];

/**
 * DEDUPE record for a threshold notice: one row per (account, quota type,
 * period, threshold). The unique index IS the dedupe — the notifier inserts
 * first and only the insert that wins sends, so concurrent increments crossing
 * 80% together (every replica, every team) produce exactly one notice.
 *
 * The period is identified by its `resetAt`, so the next period gets fresh
 * notices with no cleanup step; old rows age out on the `createdAt` TTL.
 */
export interface QuotaNoticeDocument {
  /** The account root the notice went to. */
  rootOrgId: string;
  quotaType: QuotaType;
  /** ISO `resetAt` of the period the threshold was crossed in. */
  periodResetAt: string;
  threshold: QuotaNoticeThreshold;
  createdAt: Date;
}

const quotaNoticeSchema = new Schema<QuotaNoticeDocument>({
  rootOrgId: { type: String, required: true },
  quotaType: { type: String, enum: [...VALID_QUOTA_TYPES], required: true },
  periodResetAt: { type: String, required: true },
  threshold: { type: Number, enum: [...QUOTA_NOTICE_THRESHOLDS], required: true },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'quota_threshold_notices', versionKey: false });

quotaNoticeSchema.index({ rootOrgId: 1, quotaType: 1, periodResetAt: 1, threshold: 1 }, { unique: true });
// Far longer than any sane period; only there so the collection can't grow forever.
quotaNoticeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 86_400 });

export const QuotaNotice =
  (mongoose.models.QuotaNotice as mongoose.Model<QuotaNoticeDocument>) ||
  mongoose.model<QuotaNoticeDocument>('QuotaNotice', quotaNoticeSchema);

/**
 * An account's quota settings: the threshold notices and the optional AI
 * controls. Absent row = the defaults: notices ON, no webhook, no AI controls.
 * Kept on the account ROOT — a team's usage is the pool's.
 */
export interface QuotaNoticeSettingsDocument {
  orgId: string;
  /** False opts the account out of the 80% / 100% notices entirely. */
  enabled: boolean;
  /**
   * False opts the ACCOUNT out of expansion offers
   * (docs/plans/sales-agent.md D6).
   *
   * Sits on this object rather than on a new one because the precedent is
   * exact: same account-root scope, same card (`QuotaNoticeSettingsCard`), same
   * route. `undefined` means never set, which reads as TRUE — the account
   * switch is opt-OUT, and D6's unsubscribe is what makes that defensible.
   *
   * ANDed with `enabled` for the EMAIL channel, not overriding it: "an account
   * that muted the quota channel muted the quota channel; an offer is not an
   * exception it asked for." The in-product surface is a different channel and
   * is governed by this flag alone.
   */
  offersEnabled?: boolean | null;
  /**
   * Optional HTTPS endpoint that receives a `quota.threshold` event alongside
   * the in-app notice. Delivered through api-core's SSRF-safe webhook channel
   * (vetted + pinned IP, redirects refused). Unsigned: the body carries no
   * secret and nothing actionable beyond the numbers the org's own dashboard shows.
   */
  webhookUrl?: string | null;
  /**
   * OPTIONAL AI control (default unset = none): the most any ONE member may
   * spend of the account's `aiCalls` per period, as a percent (1–100) of the
   * account's limit. Enforced by the quota service on each `aiCalls`
   * reservation (services/ai-controls.ts) → 429 `AI_MEMBER_SHARE_EXCEEDED`.
   */
  aiCallsPerMemberPct?: number | null;
  /**
   * OPTIONAL AI control (default unset = none): platform-key AI tokens (in +
   * out) the account may spend per period → 429 `AI_TOKEN_BUDGET_EXCEEDED`.
   */
  aiTokenBudget?: number | null;
  updatedAt: Date;
  updatedBy?: string;
}

const quotaNoticeSettingsSchema = new Schema<QuotaNoticeSettingsDocument>({
  orgId: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: true },
  // `null` rather than `true`: an account that has never expressed a preference
  // is distinguishable from one that opted IN, which D12's measurement wants —
  // and both read as "may be offered to" at the decision site.
  offersEnabled: { type: Boolean, default: null },
  webhookUrl: { type: String, default: null },
  aiCallsPerMemberPct: { type: Number, default: null },
  aiTokenBudget: { type: Number, default: null },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String,
}, { collection: 'quota_notice_settings', versionKey: false });

export const QuotaNoticeSettings =
  (mongoose.models.QuotaNoticeSettings as mongoose.Model<QuotaNoticeSettingsDocument>) ||
  mongoose.model<QuotaNoticeSettingsDocument>('QuotaNoticeSettings', quotaNoticeSettingsSchema);
