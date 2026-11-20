// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The bounded catalogs of the AI assistant usage report. Config-free on
 * purpose, so the request schemas and the model can both import them.
 */

/**
 * What happened to one AI-generated draft:
 *  - `accepted`        — created / applied exactly as drafted;
 *  - `edited_accepted` — the user changed it, then created / applied it;
 *  - `discarded`       — closed, dismissed or replaced without being used.
 */
export const AI_DRAFT_OUTCOMES = ['accepted', 'edited_accepted', 'discarded'] as const;
export type AiDraftOutcome = (typeof AI_DRAFT_OUTCOMES)[number];

/**
 * The report field each stored outcome is tallied into (wire names are
 * camelCase, stored outcomes snake_case). Keyed by every outcome, so a new one
 * cannot ship without a place in the report.
 */
export const AI_DRAFT_OUTCOME_TALLY_FIELDS = {
  accepted: 'accepted',
  edited_accepted: 'editedAccepted',
  discarded: 'discarded',
} as const satisfies Record<AiDraftOutcome, string>;
export type AiDraftTallyField = (typeof AI_DRAFT_OUTCOME_TALLY_FIELDS)[AiDraftOutcome];

/** Time-bucket sizes the AI usage report offers. */
export const AI_USAGE_INTERVALS = ['day', 'week'] as const;
export type AiUsageInterval = (typeof AI_USAGE_INTERVALS)[number];

/**
 * The AI features that produce a draft a user accepts or discards — the subset
 * of the ledger's `feature` values (api-server `AiFeature`) a draft outcome may
 * name. `ask` answers questions and `report-summary` writes into a report:
 * neither offers a draft to accept.
 */
export const AI_DRAFT_FEATURES = ['agent', 'pipeline-generate', 'plugin-generate'] as const;
export type AiDraftFeature = (typeof AI_DRAFT_FEATURES)[number];

/**
 * The report's FEATURE dimension, keyed, with its label. Every ledger
 * `feature` folds onto one key ({@link reportFeatureOf}): the agent's per-tool
 * generations (`agent-tool:<name>`) collapse to `agent-tool`, and anything not
 * listed (or unattributed) is `other` — so the dimension stays bounded however
 * many tools the agent grows.
 */
export const AI_REPORT_FEATURES = {
  'ask': 'Ask (how-to answers)',
  'agent': 'Ask agent',
  'agent-tool': 'Ask agent tools',
  'pipeline-generate': 'Pipeline generation',
  'plugin-generate': 'Plugin generation',
  'report-summary': 'Report summary',
  'other': 'Other',
} as const satisfies Record<string, string>;
export type AiReportFeature = keyof typeof AI_REPORT_FEATURES;

/** Fold a raw ledger `feature` onto the report catalog. */
export function reportFeatureOf(raw: string | null | undefined): AiReportFeature {
  if (!raw) return 'other';
  if (raw.startsWith('agent-tool:')) return 'agent-tool';
  return Object.hasOwn(AI_REPORT_FEATURES, raw) ? (raw as AiReportFeature) : 'other';
}

/**
 * Who made the call, at TYPE level only (never which person): a signed-in
 * user's session, an org service account, or the system (an internal service
 * or scheduled work — the ledger's `service` principal, or none).
 */
export const AI_CALLER_TYPES = ['user', 'service_account', 'system'] as const;
export type AiCallerType = (typeof AI_CALLER_TYPES)[number];

/** Labels for {@link AI_CALLER_TYPES} (the CSV and the panel use the same words). */
export const AI_CALLER_TYPE_LABELS: Record<AiCallerType, string> = {
  user: 'User sessions',
  service_account: 'Service accounts',
  system: 'System',
};
