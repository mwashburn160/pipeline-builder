// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  DeployStage, RunnerCapability, RunnerHealth, RunnerKeyMode, RunnerKeyRetiredReason, RunnerKeyState, RunnerKeyTransitionKind, RunnerLinkDetail, RunnerLinkStatus,
  RunnerPublicJwk, RunnerStatus, RunRequestAction, RunRequestStatus,
} from '@pipeline-builder/api-core/pipeline-runners';
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, pgSequence, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { jsonb } from './jsonb.js';

// The runner vocabulary is api-core's (the contract the service, the runner
// Lambda, the CLI and the dashboard share); re-exported for the schema's callers.
export {
  RUNNER_HEALTH, RUNNER_STATUSES, RUN_REQUEST_ACTIONS, RUN_REQUEST_STATUSES,
  RUNNER_KEY_STATES, RUNNER_KEY_MODES, RUNNER_KEY_RETIRED_REASONS, RUNNER_KEY_TRANSITION_KINDS, RUNNER_LINK_STATUSES,
  type RunnerHealth, type RunnerStatus, type RunRequestAction, type RunRequestStatus,
  type RunnerKeyState, type RunnerKeyMode, type RunnerKeyRetiredReason, type RunnerKeyTransitionKind, type RunnerLinkStatus, type RunnerLinkDetail,
} from '@pipeline-builder/api-core/pipeline-runners';

/**
 * Cross-account pipeline runners: a Lambda in a CUSTOMER AWS account that
 * starts/stops that account's pipelines with its own IAM role. The platform
 * holds no AWS access, no account number and no credential for it — only how
 * to reach it. Delivery is PUSH: the pipeline service POSTs a signed run
 * request to `function_url` and the answer is the HTTP response.
 *
 * `function_url` is a SECRET of the owning org: it is returned only to that
 * org's admins and never logged or audited. Register-then-deploy: a runner is
 * created `pending` with no URL; a PATCH that sets the URL and answers a signed
 * ping makes it `active`. Pending runners older than 24 h are swept.
 *
 * @table pipeline_runners
 */
export const pipelineRunner = pgTable('pipeline_runners', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  label: varchar('label', { length: 100 }).notNull(),
  /** Null while `pending` (registered, stack not deployed yet). */
  functionUrl: text('function_url'),
  shareWithTeams: boolean('share_with_teams').notNull().default(true),
  version: varchar('version', { length: 32 }),
  regions: text('regions').array().notNull().default(sql`'{}'::text[]`),
  health: varchar('health', { length: 16 }).$type<RunnerHealth>().notNull().default('healthy'),
  status: varchar('status', { length: 16 }).$type<RunnerStatus>().notNull().default('pending'),
  /** First seen below MIN_RUNNER_VERSION (the upgrade grace period runs from here). */
  updateRequiredSince: timestamp('update_required_since', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  /**
   * What the runner's bundle reported in its last pong (api-core
   * `RUNNER_CAPABILITIES`; `deploy:1`: deploys enabled). The platform never
   * signs a gated action for a runner that does not list its capability.
   */
  capabilities: text('capabilities').array().$type<RunnerCapability[]>().notNull().default(sql`'{}'::text[]`),
  /** The pipeline-name prefixes its stack allows (`*` = all), as its last pong reported them. */
  pipelinePrefixes: text('pipeline_prefixes').array().notNull().default(sql`'{}'::text[]`),
  /** Teams this runner is shared with may also DEPLOY through it (needs `share_with_teams`). */
  shareDeploysWithTeams: boolean('share_deploys_with_teams').notNull().default(false),
}, (table) => ({
  orgIdx: index('pipeline_runners_org_idx').on(table.orgId, table.status),
}));

/**
 * One signed run request (start / stop / discovery probe) for a runner, from
 * the moment a user (or the system) asks until the runner answers or the
 * request expires. The row is the durable state; the `runner-dispatch` BullMQ
 * job (jobId = id) only drives push delivery.
 *
 * @table pipeline_run_requests
 */
export const pipelineRunRequest = pgTable('pipeline_run_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineId: uuid('pipeline_id').notNull(),
  action: varchar('action', { length: 10 }).$type<RunRequestAction>().notNull(),
  executionId: varchar('execution_id', { length: 100 }),
  parentRequestId: uuid('parent_request_id'),
  requestedBy: varchar('requested_by', { length: 255 }).notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 16 }).$type<RunRequestStatus>().notNull().default('queued'),
  runnerId: uuid('runner_id'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  lastDeliveryError: varchar('last_delivery_error', { length: 64 }),
  resultExecutionId: varchar('result_execution_id', { length: 100 }),
  errorCode: varchar('error_code', { length: 64 }),
  /**
   * When the runner ACCEPTED a start/stop (the dispatcher's success verdict).
   * Null until then and for any request never accepted; rows from before the
   * column existed are null too, so readers fall back to an estimate.
   */
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
}, (table) => ({
  runnerStatusIdx: index('pipeline_run_requests_runner_status_idx').on(table.runnerId, table.status),
  statusExpiryIdx: index('pipeline_run_requests_status_expiry_idx').on(table.status, table.expiresAt),
  pipelineIdx: index('pipeline_run_requests_pipeline_idx').on(table.orgId, table.pipelineId),
  /** At most one pending start per pipeline (the G12 reuse, race-free). Same pending set as PENDING_RUN_REQUEST_STATUSES. */
  onePendingStartUq: uniqueIndex('pipeline_run_requests_one_pending_start_uq').on(table.pipelineId)
    .where(sql`action = 'start' AND status IN ('queued', 'delivering')`),
  /** At most one ACTIVE deploy per pipeline. Same set as ACTIVE_DEPLOY_STATUSES. */
  oneActiveDeployUq: uniqueIndex('pipeline_run_requests_one_active_deploy_uq').on(table.pipelineId)
    .where(sql`action = 'deploy' AND status IN ('queued', 'delivering', 'deploying')`),
  /** The target of pipeline_runner_deploys' (request_id, org_id) key (FK checks bypass RLS). */
  idOrgUq: unique('pipeline_run_requests_id_org_uq').on(table.id, table.orgId),
}));

/**
 * The deploy half of a `deploy` / `undeploy` run request: what the runner's
 * CodeBuild job runs, where it is, and the job's credentials.
 *
 *  - `grant_hash` — sha256 (hex) of the single-use job grant (`pb_dg_…`), the
 *    only form the grant is kept in clear; `grant_enc` — the grant encrypted
 *    with the org's `encryptSecret` (re-signed on a redelivery), wiped at the
 *    exchange and at any terminal status; `grant_expires_at` — the exchange
 *    deadline (api-core `deployGrantTtlMs`); `grant_used_at` — the exchange.
 *  - `session_hash` / `session_expires_at` — the session token (`pb_ds_…`)
 *    the exchange issued, sha256 only; nulled at any terminal status.
 *  - `build_id` — the runner's CodeBuild build (`<project>:<uuid>`, no
 *    account id); `deadline_at` — RUNNER_DEPLOY_DEADLINE_MINUTES after the
 *    runner accepted; `next_poll_at` — the sweep's next signed deploy_status.
 *  - `stage` — the job's last reported stage; `result_code` — its result.
 *
 * NO route, log, audit entry or export ever carries `grant_enc`, `grant_hash`
 * or `session_hash`. Own org only under RLS (no system-org read).
 *
 * @table pipeline_runner_deploys
 */
export const pipelineRunnerDeploy = pgTable('pipeline_runner_deploys', {
  requestId: uuid('request_id').primaryKey(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineId: uuid('pipeline_id').notNull(),
  region: varchar('region', { length: 30 }).notNull(),
  pipelineName: varchar('pipeline_name', { length: 255 }).notNull(),
  stackName: varchar('stack_name', { length: 255 }).notNull(),
  imageDigest: varchar('image_digest', { length: 80 }).notNull(),
  toolchainRelease: varchar('toolchain_release', { length: 50 }).notNull(),
  buildId: varchar('build_id', { length: 255 }),
  stage: varchar('stage', { length: 16 }).$type<DeployStage>().notNull().default('queued'),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
  grantHash: varchar('grant_hash', { length: 64 }),
  grantEnc: text('grant_enc'),
  grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }).notNull(),
  grantUsedAt: timestamp('grant_used_at', { withTimezone: true }),
  sessionHash: varchar('session_hash', { length: 64 }),
  sessionExpiresAt: timestamp('session_expires_at', { withTimezone: true }),
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  cancelledBy: varchar('cancelled_by', { length: 255 }),
  resultCode: varchar('result_code', { length: 64 }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pipelineIdx: index('pipeline_runner_deploys_pipeline_idx').on(table.orgId, table.pipelineId),
  /** Tied to its request AND that request's org: a row can never carry another org's id for a request. */
  requestFk: foreignKey({ name: 'pipeline_runner_deploys_request_fk', columns: [table.requestId, table.orgId], foreignColumns: [pipelineRunRequest.id, pipelineRunRequest.orgId] })
    .onDelete('cascade'),
  pollIdx: index('pipeline_runner_deploys_poll_idx').on(table.nextPollAt).where(sql`next_poll_at IS NOT NULL`),
  stageCheck: check('pipeline_runner_deploys_stage_check',
    sql`stage IN ('queued', 'starting', 'authenticating', 'fetching', 'prechecking', 'cleaning', 'synthesizing', 'deploying', 'registering', 'removing', 'done')`),
}));

/**
 * The runner-link VIEW of `pipeline_registry`: the same table, mapped with only
 * the columns runner routing reads plus the link columns:
 *  - `runner_id` — the runner that starts/stops the pipeline. Set by a single
 *    match (discovery, rediscovery, the background probe at registration, or
 *    Find runner again) or a verified run; cleared when the runner is revoked
 *    or answers that the pipeline's identity tag is missing/mismatched.
 *  - `runner_link_status` / `runner_link_checked_at` / `runner_link_detail` —
 *    the last probe's outcome, written by every probe. The detail carries runner
 *    LABELS only, never an account id or a URL.
 *
 * Kept apart from `pipelineRegistry` so registry queries that have nothing to
 * do with runners don't select the link. Not part of the aggregate `schema` object.
 */
export const pipelineRegistryRunnerLink = pgTable('pipeline_registry', {
  id: uuid('id').primaryKey(),
  pipelineId: uuid('pipeline_id').notNull(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineName: varchar('pipeline_name', { length: 255 }).notNull(),
  region: varchar('region', { length: 30 }),
  runnerId: uuid('runner_id'),
  runnerLinkStatus: varchar('runner_link_status', { length: 16 }).$type<RunnerLinkStatus>().notNull().default('unlinked'),
  runnerLinkCheckedAt: timestamp('runner_link_checked_at', { withTimezone: true }),
  runnerLinkDetail: jsonb('runner_link_detail').$type<RunnerLinkDetail>(),
});

/**
 * The one sequence every runner-key change draws its `runner_key_version` from
 * (key rows AND key-settings rows). An org's key version is the MAX over the key
 * rows and settings rows of its effective-key chain (itself + its ancestors):
 * every change raises it and nothing lowers it (rows are never deleted outside
 * an org purge), so a replica that compares it with the value it cached never
 * misses a change, even across orgs.
 */
export const pipelineRunnerKeyVersionSeq = pgSequence('pipeline_runner_key_version_seq');

const nextKeyVersion = sql`nextval('pipeline_runner_key_version_seq')`;

/**
 * One Ed25519 run-request signing key of an org. The private key is the PKCS#8
 * PEM, encrypted with `encryptSecret(pem, orgId)` and stored as the
 * JSON-serialized `EncryptedBlob` in `private_key_enc`. NO route, log, audit
 * entry or export ever carries `private_key_enc` (the org-data export strips it,
 * see `secretColumns` in org-data-ownership).
 *
 * States: `next` (published, signs from `activates_at`) → `active` (signs) →
 * `retiring` (published until `retire_after`) → `retired` (row kept for audit,
 * `private_key_enc` NULL — a CHECK holds that). A cancelled `next` key is
 * retired too (`retired_reason = 'cancelled'`), never deleted. At most one
 * next / active / retiring per org (partial unique indexes).
 *
 * `activates_at`: when it signs (next) or started signing (active, retiring);
 * key age is counted from it. `age_reminder_sent_at` / `age_followup_sent_at`:
 * the once-only reminders at RUNNER_KEY_MAX_AGE_DAYS and 30 days after.
 *
 * @table pipeline_runner_signing_keys
 */
export const pipelineRunnerSigningKey = pgTable('pipeline_runner_signing_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  /** RFC 7638 thumbprint of the public key (base64url SHA-256, 43 chars). */
  kid: varchar('kid', { length: 64 }).notNull(),
  publicJwk: jsonb('public_jwk').$type<RunnerPublicJwk>().notNull(),
  /** JSON `EncryptedBlob`; NULL exactly when retired. */
  privateKeyEnc: text('private_key_enc'),
  state: varchar('state', { length: 16 }).$type<RunnerKeyState>().notNull(),
  activatesAt: timestamp('activates_at', { withTimezone: true }).notNull(),
  retireAfter: timestamp('retire_after', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  retiredReason: varchar('retired_reason', { length: 16 }).$type<RunnerKeyRetiredReason>(),
  runnerKeyVersion: bigint('runner_key_version', { mode: 'number' }).notNull().default(nextKeyVersion),
  ageReminderSentAt: timestamp('age_reminder_sent_at', { withTimezone: true }),
  ageFollowupSentAt: timestamp('age_followup_sent_at', { withTimezone: true }),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  kidUq: uniqueIndex('pipeline_runner_signing_keys_kid_uq').on(table.kid),
  orgStateIdx: index('pipeline_runner_signing_keys_org_state_idx').on(table.orgId, table.state),
  oneNextUq: uniqueIndex('pipeline_runner_signing_keys_one_next_uq').on(table.orgId).where(sql`state = 'next'`),
  oneActiveUq: uniqueIndex('pipeline_runner_signing_keys_one_active_uq').on(table.orgId).where(sql`state = 'active'`),
  oneRetiringUq: uniqueIndex('pipeline_runner_signing_keys_one_retiring_uq').on(table.orgId).where(sql`state = 'retiring'`),
  stateCheck: check('pipeline_runner_signing_keys_state_check', sql`state IN ('next', 'active', 'retiring', 'retired')`),
  retiredReasonCheck: check('pipeline_runner_signing_keys_retired_reason_check',
    sql`retired_reason IS NULL OR retired_reason IN ('finished', 'revoked', 'cancelled', 'mode_switch')`),
  wipedCheck: check('pipeline_runner_signing_keys_wiped_check', sql`(state = 'retired') = (private_key_enc IS NULL)`),
  retireAfterCheck: check('pipeline_runner_signing_keys_retire_after_check', sql`state <> 'retiring' OR retire_after IS NOT NULL`),
}));

/**
 * An org's key mode. A missing row means `inherit` for a sub-organization and
 * `own` for a root org (a root org may have a row, always `own`).
 *
 * A transition (inherit → own, own → inherit, or an ancestry change) keeps the
 * PREVIOUS effective key org's keys published for this org's runners:
 *  - `previous_key_org_id` — the effective key org before the transition;
 *  - `switch_at` — when signing moves from it to the new effective key org
 *    (to_own: the new key's activates_at; to_inherit / ancestry: change + 10 min);
 *  - `transition_until` — when its keys leave this org's JWKS (switch_at + 1 h);
 *    the sweep then clears all three and `transition_kind`.
 * `effective_key_org_id` is the effective key org as last resolved — how the
 * sweep notices an ancestry change (a team moved, or its parent deleted).
 *
 * @table pipeline_runner_key_settings
 */
export const pipelineRunnerKeySettings = pgTable('pipeline_runner_key_settings', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  mode: varchar('mode', { length: 16 }).$type<RunnerKeyMode>().notNull(),
  modeChangedAt: timestamp('mode_changed_at', { withTimezone: true }).defaultNow().notNull(),
  effectiveKeyOrgId: varchar('effective_key_org_id', { length: 255 }),
  transitionKind: varchar('transition_kind', { length: 16 }).$type<RunnerKeyTransitionKind>(),
  previousKeyOrgId: varchar('previous_key_org_id', { length: 255 }),
  switchAt: timestamp('switch_at', { withTimezone: true }),
  transitionUntil: timestamp('transition_until', { withTimezone: true }),
  runnerKeyVersion: bigint('runner_key_version', { mode: 'number' }).notNull().default(nextKeyVersion),
  updatedBy: varchar('updated_by', { length: 255 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, () => ({
  modeCheck: check('pipeline_runner_key_settings_mode_check', sql`mode IN ('inherit', 'own')`),
  transitionCheck: check('pipeline_runner_key_settings_transition_check',
    sql`(transition_kind IS NULL AND previous_key_org_id IS NULL AND switch_at IS NULL AND transition_until IS NULL) OR (transition_kind IN ('to_own', 'to_inherit', 'ancestry') AND switch_at IS NOT NULL AND transition_until IS NOT NULL)`),
}));

/**
 * The deployment-wide runner switches: one row at most (the PK can only hold
 * TRUE); a missing row means "not paused". `deliveries_paused` is the
 * system-org "Pause all pipeline runs" toggle: nothing is signed or delivered
 * and runs answer 409 RUNNERS_UNAVAILABLE while it is on. System-org only (RLS).
 *
 * @table pipeline_runner_platform_settings
 */
export const pipelineRunnerPlatformSettings = pgTable('pipeline_runner_platform_settings', {
  singleton: boolean('singleton').primaryKey().default(true),
  deliveriesPaused: boolean('deliveries_paused').notNull().default(false),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  pausedBy: varchar('paused_by', { length: 255 }),
  pauseReason: text('pause_reason'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  singletonCheck: check('pipeline_runner_platform_settings_singleton_check', sql`${table.singleton}`),
}));

export type PipelineRunnerDeployRow = typeof pipelineRunnerDeploy.$inferSelect;
export type PipelineRunnerDeployInsert = typeof pipelineRunnerDeploy.$inferInsert;
export type PipelineRunnerSigningKeyRow = typeof pipelineRunnerSigningKey.$inferSelect;
export type PipelineRunnerSigningKeyInsert = typeof pipelineRunnerSigningKey.$inferInsert;
export type PipelineRunnerKeySettingsRow = typeof pipelineRunnerKeySettings.$inferSelect;
export type PipelineRunnerKeySettingsInsert = typeof pipelineRunnerKeySettings.$inferInsert;
export type PipelineRunnerPlatformSettingsRow = typeof pipelineRunnerPlatformSettings.$inferSelect;
