// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE catalog of AI-draft outcomes, shared by the services that produce,
 * report and count them:
 *
 *  - the pipeline / plugin generators and the Ask agent issue a draft id per
 *    draft, naming the feature that produced it ({@link AI_DRAFT_FEATURES});
 *  - ask-agent's `POST /ask-agent/draft-outcome` validates the outcome a user
 *    reports against both catalogs;
 *  - the quota service validates the forwarded count again and stores it in
 *    its draft-outcome buckets (api/quota `services/ai-draft-catalog.ts`
 *    re-exports these).
 *
 * Config-free on purpose, so request schemas and models can all import it.
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
 * The AI features that produce a draft a user accepts or discards — the subset
 * of the AI usage ledger's `feature` values (api-server `AiFeature`) a draft
 * outcome may name. `ask` answers questions and `report-summary` writes into a
 * report: neither offers a draft to accept.
 */
export const AI_DRAFT_FEATURES = ['agent', 'pipeline-generate', 'plugin-generate'] as const;
export type AiDraftFeature = (typeof AI_DRAFT_FEATURES)[number];

/**
 * Lifetime of a draft id (1 h): long enough for a user to review and edit a
 * draft before creating it, short enough that a harvested id is soon worthless.
 */
export const AI_DRAFT_ID_TTL_MS = 60 * 60 * 1000;

/** Shape of a draft id: 24 random bytes, base64url (32 characters). */
export const AI_DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
