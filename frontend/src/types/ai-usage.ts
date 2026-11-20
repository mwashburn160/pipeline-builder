// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { WeekStart } from '@pipeline-builder/api-core';

/**
 * The AI assistant usage report (`GET /api/quota/:orgId/ai-usage` → `data.report`).
 *
 * Copies of the quota service's wire shapes (api/quota/src/services/ai-usage-report.ts),
 * which the client cannot import; kept identical by test/wire-type-drift.test.ts.
 * Never per person: a caller is a TYPE, a team is an org.
 */

/** What a user did with one AI-generated draft. */
export type AiDraftOutcome = 'accepted' | 'edited_accepted' | 'discarded';

/** The features that produce a draft to accept or discard. */
export type AiDraftFeature = 'agent' | 'pipeline-generate' | 'plugin-generate';

/** The report's feature dimension (the server folds every ledger feature onto one). */
export type AiReportFeature = 'ask' | 'agent' | 'agent-tool' | 'pipeline-generate' | 'plugin-generate' | 'report-summary' | 'other';

/** Who made the call, by type only. */
export type AiCallerType = 'user' | 'service_account' | 'system';

export type AiUsageInterval = 'day' | 'week';

/** One time bucket: usage plus the draft outcomes recorded in it. */
export interface AiUsageBucketRow {
  /** `YYYY-MM-DD` — the day, or the first day of the week, in the report's tz. */
  bucket: string;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
  accepted: number;
  editedAccepted: number;
  discarded: number;
  outcomes: number;
  /** (accepted + edited) / outcomes; null with no outcomes. */
  acceptanceRate: number | null;
}

/** Usage by caller type. */
export interface AiCallerTypeRow {
  callerType: AiCallerType;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
}

/** Usage by team (rollup only). `name` null when the org row is unreadable. */
export interface AiTeamRow {
  orgId: string;
  name: string | null;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
}

/** Usage and acceptance by feature. */
export interface AiFeatureRow {
  feature: AiReportFeature;
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
  accepted: number;
  editedAccepted: number;
  discarded: number;
  outcomes: number;
  acceptanceRate: number | null;
}

/** The whole-range totals. */
export interface AiUsageTotals {
  calls: number;
  units: number;
  tokensIn: number;
  tokensOut: number;
  accepted: number;
  editedAccepted: number;
  discarded: number;
  outcomes: number;
  acceptanceRate: number | null;
}

/** The report. */
export interface AiUsageReport {
  orgId: string;
  /** `org`: this org's own usage; `rollup`: the account (the org and its teams). */
  scope: 'org' | 'rollup';
  from: string;
  to: string;
  interval: AiUsageInterval;
  tz: string;
  weekStart: WeekStart;
  retentionDays: number;
  /** When the first draft outcome in scope was recorded; null when none ever was. */
  acceptanceSince: string | null;
  totals: AiUsageTotals;
  buckets: AiUsageBucketRow[];
  byCallerType: AiCallerTypeRow[];
  /** Null unless `scope` is `rollup`. */
  byTeam: AiTeamRow[] | null;
  byFeature: AiFeatureRow[];
}

/** Query of the report. */
export interface AiUsageReportParams {
  from?: string;
  to?: string;
  interval?: AiUsageInterval;
  includeDescendants?: boolean;
  tz?: string;
  weekStart?: WeekStart;
}
