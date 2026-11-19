// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RunnerHealth, RunnerStatus, RunRequestAction, RunRequestStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

// The runner vocabulary is api-core's (the contract the service, the runner
// Lambda, the CLI and the dashboard share); re-exported for the schema's callers.
export {
  RUNNER_HEALTH, RUNNER_STATUSES, RUN_REQUEST_ACTIONS, RUN_REQUEST_STATUSES,
  type RunnerHealth, type RunnerStatus, type RunRequestAction, type RunRequestStatus,
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
}, (table) => ({
  runnerStatusIdx: index('pipeline_run_requests_runner_status_idx').on(table.runnerId, table.status),
  statusExpiryIdx: index('pipeline_run_requests_status_expiry_idx').on(table.status, table.expiresAt),
  pipelineIdx: index('pipeline_run_requests_pipeline_idx').on(table.orgId, table.pipelineId),
  /** At most one pending start per pipeline (the G12 reuse, race-free). Same pending set as PENDING_RUN_REQUEST_STATUSES. */
  onePendingStartUq: uniqueIndex('pipeline_run_requests_one_pending_start_uq').on(table.pipelineId)
    .where(sql`action = 'start' AND status IN ('queued', 'delivering')`),
}));

/**
 * The runner-link VIEW of `pipeline_registry`: the same table, mapped with only
 * the columns runner routing reads plus `runner_id` — the cross-account runner
 * that starts/stops the pipeline. Set only after a VERIFIED run (or a
 * single-match discovery probe); cleared when the runner is revoked or answers
 * that the pipeline's identity tag is missing/mismatched. NULL = the
 * platform-account path.
 *
 * Kept apart from `pipelineRegistry` so no existing registry query references
 * `runner_id` (absent on a database created before runners). Not part of the
 * aggregate `schema` object.
 */
export const pipelineRegistryRunnerLink = pgTable('pipeline_registry', {
  id: uuid('id').primaryKey(),
  pipelineId: uuid('pipeline_id').notNull(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineName: varchar('pipeline_name', { length: 255 }).notNull(),
  region: varchar('region', { length: 30 }),
  runnerId: uuid('runner_id'),
});
