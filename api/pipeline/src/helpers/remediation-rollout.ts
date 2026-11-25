// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 3 of the nightly plugin CVE remediation: moving pipelines onto a
 * published fix version (docs/plugin-publishing.md "Scan gates"). The plugin
 * service publishes the fix and calls PIPELINE_INTERNAL.startRemediationRollout;
 * this service owns everything after that, one `pipeline_remediation_upgrades`
 * row per (remediation, pipeline), which is the rollout's whole durable state:
 * the summary (status, waves, counts) is derived from the rows every tick.
 *
 * Who gets what (per pipeline, from what its steps resolve to — the contract
 * check's resolver, i.e. what synth would pick):
 *   - a step pinned exactly to the flagged version: the pin is rewritten to the
 *     fix (`step_pin`) through the plugin-upgrades apply path (template
 *     validation, contract check, compliance, resolution recording, audit);
 *   - a step whose install policy already admits the fix (patch / minor /
 *     latest, implicit Official): a redeploy, so synth picks it up now
 *     (`redeploy`);
 *   - a listing install pinned to the flagged version: the install is moved
 *     (`install_pin`); an approval-gated install (its publisher's tier needs
 *     approval under the org's consumption policy), or any install in propose
 *     mode, gets an install CHANGE REQUEST instead, never a move. A team's
 *     inherited install is the root's row: the root org's rollout moves it.
 *   - Team pipelines only get PROPOSALS for pins in their own config.
 *   - An apply-mode install move whose install has ANOTHER change request
 *     pending waits (`waiting_change_request`) — only that pipeline; the rest
 *     of the rollout proceeds. Once the request is decided the worker resumes
 *     it: approved → moved / redeployed as planned; rejected (still pinned to
 *     the flagged version) → `dismissed`, error `change_request_rejected`. A
 *     change request is only opened while the install still pins `fromVersion`.
 *
 * Effective mode (resolveRemediationRollout: pipeline, then team, then root) is
 * resolved when the rows are created AND again just before each move.
 *   - off → `skipped_opt_out`, never moved; propose → `proposed` (applied from
 *     the pipeline page); apply → `queued`, moved in waves.
 *
 * Waves (apply): a canary of up to 5 (preferring pipelines with a successful
 * run in the last 7 days), wait until each canary run finishes, stop on a
 * failure on a step using the new version; then batches of 50, each started
 * once the previous batch's runs have started (system starts queue past the
 * org's pending cap; this pacing is what keeps a batch within the org's run
 * limits). A pipeline whose runner is unhealthy is `skipped_runner` and retried
 * in a later wave (at most hourly) — its linked runner, or (unlinked) every
 * runner routing could pick for it (`eligibleRunners`); after
 * {@link RUNNER_RETRY_MAX_AGE_MS} it ends `failed` (`runner_unhealthy_expired`).
 * A move whose redeploy did not start (duplicate window, runner refusal) is
 * `moved_pending_redeploy`: its wave is not settled and the rollout not done
 * until a retried redeploy starts (every {@link REDEPLOY_RETRY_MS}, up to
 * {@link REDEPLOY_MAX_ATTEMPTS} attempts, then `failed`, `redeploy_retries_exhausted`).
 *
 * Rollback: a failed run on a step using the new version within 24 h of the
 * move — failed actions mapped to steps / plugins through the pipeline's stored
 * step-to-plugin mapping (`pipeline_step_manifests`); with no mapping, any
 * failed event of the moved run (the run request's result execution; any
 * failed event when the move started no run) — moves the pipeline back, only to a LIVE previous
 * version (deleted → `rollback_blocked`, the rollout pauses) and never to one
 * with a KEV-listed Critical finding unless the pipeline's risk acceptance
 * covers it (→ `rollback_blocked`). Two rollbacks pause the rollout.
 *
 * Progress goes back to the plugin service (PLUGIN_INTERNAL.reportRemediationRollout),
 * which stores the summary, moves the remediation's stage and sends N37 / N38.
 */

import {
  actorId,
  callInternal,
  createLogger,
  createScheduler,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  isVersionRange,
  leaderLockKey,
  managedToolchainRefName,
  PIPELINE_REMEDIATION_UPGRADE_STATES,
  PLUGIN_INTERNAL,
  PluginFilterSchema,
  recordAudit,
  REMEDIATION_BATCH_SIZE,
  REMEDIATION_CANARY_RECENT_DAYS,
  REMEDIATION_CANARY_SIZE,
  REMEDIATION_MAX_ROLLBACKS,
  REMEDIATION_ROLLBACK_WINDOW_MS,
  scanFindingKey,
  serviceEndpoint,
  serviceIdentity,
  SYSTEM_ORG_ID,
  SYSTEM_PLUGIN_REMEDIATION,
  versionScanFacts,
  type PipelineRemediationElection,
  type PipelineRemediationUpgradeState,
  type PluginRemediationRollout,
  type RemediationRolloutPauseReason,
  type RemediationRolloutStatus,
  type RemediationRolloutSummary,
  type RemediationRolloutWave,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { PENDING_RUN_REQUEST_STATUSES } from '@pipeline-builder/api-core/pipeline-runners';
import { collectPluginSteps, pluginLookupFilter, type PluginStepRef } from '@pipeline-builder/pipeline-core';
import {
  acceptanceKey,
  activeAcceptances,
  drizzleListingSource,
  failedStatusList,
  getTenantContext,
  orgListingStates,
  runWithTenantContext,
  terminalStatusList,
  withTenantTx,
  type PluginFilter,
} from '@pipeline-builder/pipeline-data';
import { sql, type SQL } from 'drizzle-orm';
import { recordPipelineResolution, resolveContractPlugin } from './plugin-contract-check.js';
import { applyUpgradeToPipeline, redeployPipeline, type ApplyActor } from './plugin-upgrade-apply.js';
import { applyPluginUpgrades, type StepUpgrade } from './plugin-upgrades.js';
import { effectiveRollout, readOrgRolloutSettings, remediationEnabled, settingsReader, type OrgRolloutSettings } from './remediation-settings.js';
import { runnerDeps, type RunnerDeps } from '../runners/deps.js';
import { eligibleRunners } from '../runners/routing.js';
import type { Pipeline } from '../services/pipeline-service.js';

const logger = createLogger('remediation-rollout');

/** Retry an unhealthy-runner skip at most this often. */
export const RUNNER_RETRY_MS = 3_600_000;
/** Stop retrying unhealthy-runner skips after this long. */
export const RUNNER_RETRY_MAX_AGE_MS = 7 * 86_400_000;
/** The worker's tick. */
export const ROLLOUT_TICK_MS = 60_000;
/** Retry a move's redeploy that did not start at most this often (past the start path's duplicate window). */
export const REDEPLOY_RETRY_MS = 10 * 60_000;
/** Redeploy attempts of one move (the move's own included) before it ends `failed`. */
export const REDEPLOY_MAX_ATTEMPTS = 6;
/** The `error` of a moved_pending_redeploy row: `redeploy_failed:<attempts so far>`. */
const REDEPLOY_FAILED = 'redeploy_failed';
const redeployAttempts = (error: string | null): number => {
  const m = /^redeploy_failed(?::(\d+))?$/.exec(error ?? '');
  return m ? Number(m[1] ?? 1) : 1;
};

/** The system principal every rollout move, redeploy and audit runs as. */
export const REMEDIATION_ACTOR: ApplyActor = { userId: SYSTEM_PLUGIN_REMEDIATION, requestedBy: SYSTEM_PLUGIN_REMEDIATION };

/** A pipeline step / install's view of a remediation: move `plugin` (by `publisher`) from `fromVersion` to `toVersion`. */
export interface RemediationRef {
  remediationId: string;
  plugin: string;
  publisher: string | null;
  fromVersion: string;
  toVersion: string;
}

/** A listing install pinned to the version being moved off. */
export interface PinnedInstall {
  id: string;
  /** The install row's org (a team's inherited install is its ROOT's). */
  orgId: string;
  /** Approval-gated: the publisher's tier needs approval under the org's consumption policy. */
  gated: boolean;
  /** The install has a change request pending (anyone's): an apply-mode move of it waits. */
  pendingChange?: boolean;
}

/** What moving one pipeline takes. */
export interface MovePlan {
  /** `step_pin`: exact pins to rewrite; `install_pin`: an install to move; `redeploy`: already admitted; else nothing can move it. */
  kind: 'step_pin' | 'install_pin' | 'redeploy' | 'not_admitted' | 'stale';
  steps: StepUpgrade[];
  install: PinnedInstall | null;
}

/** One row of `pipeline_remediation_upgrades`, as the engine reads it. */
export interface UpgradeRow {
  id: string;
  orgId: string;
  /** The root org the rollout start resolved for a team's row (null: a root org's own pipeline — no parent). Every row's later step plans under it as stored. */
  rootOrgId: string | null;
  remediationId: string;
  pipelineId: string;
  pluginName: string;
  pluginPublisher: string | null;
  fromVersion: string;
  toVersion: string;
  mode: 'off' | 'propose' | 'apply';
  state: PipelineRemediationUpgradeState;
  wave: number | null;
  movedAt: Date | null;
  runRequestId: string | null;
  rolledBackAt: Date | null;
  rolledBackTo: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The pipeline row fields the engine reads. */
export type RolloutPipeline = Pick<Pipeline, 'id' | 'orgId' | 'props' | 'pipelineName'> & { remediationUpgrades: PipelineRemediationElection; deletedAt?: Date | null };

/** The outcome of a move or a rollback. */
export type MoveResult = { ok: true; runRequestId: string | null; note?: string } | { ok: false; error: string };

/** A rollback's target check. */
export type RollbackTargetCheck = { ok: true } | { ok: false; reason: 'previous_version_deleted' | 'previous_version_kev' };

/** What the engine calls out to (the real ones by default; fakes in tests). */
export interface RolloutDeps {
  now(): Date;
  settings(orgId: string, rootOrgId: string | null): Promise<OrgRolloutSettings>;
  plan(pipeline: RolloutPipeline, rootOrgId: string | null, ref: RemediationRef, opts?: { pinRanges?: boolean }): Promise<MovePlan>;
  move(input: { row: UpgradeRow; pipeline: RolloutPipeline; rootOrgId: string | null; ref: RemediationRef; plan: MovePlan; actor: ApplyActor; rollback?: boolean }): Promise<MoveResult>;
  requestInstallChange(install: PinnedInstall, ref: RemediationRef): Promise<void>;
  /** Re-start the redeploy of a move whose redeploy did not start (ok with `note: 'redeploy_failed'` when it still did not). */
  redeploy(input: { row: UpgradeRow; pipeline: RolloutPipeline; rootOrgId: string | null }): Promise<MoveResult>;
  rollbackTarget(row: UpgradeRow, rootOrgId: string | null): Promise<RollbackTargetCheck>;
  report(remediationId: string, body: { summary: RemediationRolloutSummary; events: RolloutEvent[] }): Promise<'ok' | 'unknown' | 'failed'>;
  /** The org's ancestors in the platform hierarchy (nearest first); throws when it cannot be read. */
  ancestors(orgId: string): Promise<string[]>;
  /** Every descendant of the org in the platform hierarchy (all levels, without the org); throws when it cannot be read. */
  descendants(orgId: string): Promise<string[]>;
}

/** A per-pipeline event the plugin service turns into notices (N38). */
export interface RolloutEvent {
  kind: 'rolled_back' | 'rollback_blocked';
  orgId: string;
  pipelineId: string;
  fromVersion: string;
  toVersion: string;
  at: string;
}

/** The body of PIPELINE_INTERNAL.startRemediationRollout. */
export interface StartRolloutInput {
  orgId: string | null;
  plugin: string;
  publisher: string | null;
  fromVersion: string;
  toVersion: string;
  toPluginId: string;
  advisoryIds: string[];
  criticalCleared: number;
  highCleared: number;
  kev: boolean;
}

export type StateCounts = Record<PipelineRemediationUpgradeState, number>;

// -- SQL helpers -------------------------------------------------------------------

/** Rows a rollout has not decided yet: a repeat start re-targets them, a cancel supersedes them. */
const OPEN_STATES = ['proposed', 'queued', 'change_requested', 'skipped_runner', 'waiting_change_request'] as const satisfies readonly PipelineRemediationUpgradeState[];
/** Rows a wave may move. */
const MOVABLE_STATES = ['queued', 'skipped_runner'] as const satisfies readonly PipelineRemediationUpgradeState[];
/** The `error` that marks a move refused because its install has another change pending. */
export const INSTALL_CHANGE_PENDING = 'install_change_pending';

const stateList = (states: readonly PipelineRemediationUpgradeState[]): SQL => sql.join(states.map((s) => sql`${s}`), sql`, `);

type Tx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])) as T[];
}

/** Every rollout read / write is cross-org (the rows name their orgs): sysadmin scope, explicit ids. */
function asSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));
}

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

function toRow(r: Record<string, unknown>): UpgradeRow {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    rootOrgId: (r.root_org_id as string | null) ?? null,
    remediationId: String(r.remediation_id),
    pipelineId: String(r.pipeline_id),
    pluginName: String(r.plugin_name),
    pluginPublisher: (r.plugin_publisher as string | null) ?? null,
    fromVersion: String(r.from_version),
    toVersion: String(r.to_version),
    mode: r.mode as UpgradeRow['mode'],
    state: r.state as PipelineRemediationUpgradeState,
    wave: r.wave === null || r.wave === undefined ? null : Number(r.wave),
    movedAt: toDate(r.moved_at),
    runRequestId: (r.run_request_id as string | null) ?? null,
    rolledBackAt: toDate(r.rolled_back_at),
    rolledBackTo: (r.rolled_back_to as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: toDate(r.created_at)!,
    updatedAt: toDate(r.updated_at)!,
  };
}

/** Every row of one remediation. */
export async function loadRows(remediationId: string): Promise<UpgradeRow[]> {
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT * FROM pipeline_remediation_upgrades WHERE remediation_id = ${remediationId}::uuid ORDER BY created_at, pipeline_id`));
  return rowsOf<Record<string, unknown>>(res).map(toRow);
}

/** One pipeline's rows (the pipeline page). */
export async function loadPipelineRows(pipelineId: string): Promise<UpgradeRow[]> {
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT * FROM pipeline_remediation_upgrades WHERE pipeline_id = ${pipelineId}::uuid ORDER BY created_at DESC LIMIT 100`));
  return rowsOf<Record<string, unknown>>(res).map(toRow);
}

interface RowPatch {
  state?: PipelineRemediationUpgradeState;
  mode?: UpgradeRow['mode'];
  wave?: number | null;
  rootOrgId?: string | null;
  movedAt?: Date | null;
  runRequestId?: string | null;
  rolledBackAt?: Date | null;
  rolledBackTo?: string | null;
  error?: string | null;
  toVersion?: string;
}

/**
 * Patch one row, optionally only while it is still in one of `fromStates` (a
 * concurrent apply / dismiss / cancel decided it first → false).
 */
export async function patchRow(id: string, patch: RowPatch, fromStates?: readonly PipelineRemediationUpgradeState[]): Promise<boolean> {
  const sets: SQL[] = [];
  if (patch.state !== undefined) sets.push(sql`state = ${patch.state}`);
  if (patch.mode !== undefined) sets.push(sql`mode = ${patch.mode}`);
  if (patch.wave !== undefined) sets.push(sql`wave = ${patch.wave}`);
  if (patch.movedAt !== undefined) sets.push(sql`moved_at = ${patch.movedAt ? patch.movedAt.toISOString() : null}::timestamptz`);
  if (patch.runRequestId !== undefined) sets.push(sql`run_request_id = ${patch.runRequestId}::uuid`);
  if (patch.rolledBackAt !== undefined) sets.push(sql`rolled_back_at = ${patch.rolledBackAt ? patch.rolledBackAt.toISOString() : null}::timestamptz`);
  if (patch.rolledBackTo !== undefined) sets.push(sql`rolled_back_to = ${patch.rolledBackTo}`);
  if (patch.error !== undefined) sets.push(sql`error = ${patch.error === null ? null : patch.error.slice(0, 255)}`);
  if (patch.toVersion !== undefined) sets.push(sql`to_version = ${patch.toVersion}`);
  if (patch.rootOrgId !== undefined) sets.push(sql`root_org_id = ${patch.rootOrgId}`);
  sets.push(sql`updated_at = now()`);
  const guard = fromStates && fromStates.length > 0
    ? sql` AND state IN (${stateList(fromStates)})`
    : sql``;
  const res = await asSystem((tx) => tx.execute(sql`
    UPDATE pipeline_remediation_upgrades SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid${guard} RETURNING id`));
  return rowsOf(res).length > 0;
}

/** Org ids per candidate query: a large subtree is read in batches, never one unbounded IN list. */
const CANDIDATE_ORG_BATCH = 500;

/**
 * The pipelines (with their org, recorded root org) using `fromVersion` —
 * declared or deployed. `orgIds` null: every org (an official, instance-wide
 * rollout); else only pipelines OWNED by one of `orgIds` (a scoped rollout
 * passes the scope org and its LIVE descendants — never matched on the root
 * a resolution row recorded, which goes stale when a team moves).
 */
export async function rolloutCandidates(
  input: Pick<StartRolloutInput, 'plugin' | 'publisher' | 'fromVersion'>,
  orgIds: string[] | null,
): Promise<Array<{ orgId: string; pipelineId: string; rootOrgId: string | null }>> {
  if (orgIds === null) return candidatesIn(input, null);
  const ids = [...new Set(orgIds.map((o) => o.toLowerCase()))];
  const byId = new Map<string, { orgId: string; pipelineId: string; rootOrgId: string | null }>();
  for (let i = 0; i < ids.length; i += CANDIDATE_ORG_BATCH) {
    for (const c of await candidatesIn(input, ids.slice(i, i + CANDIDATE_ORG_BATCH))) byId.set(c.pipelineId, c);
  }
  return [...byId.values()].sort((a, b) => (a.pipelineId < b.pipelineId ? -1 : a.pipelineId > b.pipelineId ? 1 : 0));
}

async function candidatesIn(
  input: Pick<StartRolloutInput, 'plugin' | 'publisher' | 'fromVersion'>,
  orgIds: string[] | null,
): Promise<Array<{ orgId: string; pipelineId: string; rootOrgId: string | null }>> {
  const pub = (col: string) => (input.publisher === null ? sql` AND ${sql.raw(col)} IS NULL` : sql` AND ${sql.raw(col)} = ${input.publisher}`);
  if (orgIds !== null && orgIds.length === 0) return [];
  const orgFilter = orgIds === null
    ? sql``
    : sql` AND lower(p.org_id) IN (${sql.join(orgIds.map((o) => sql`${o}`), sql`, `)})`;
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT DISTINCT p.org_id, p.id::text AS pipeline_id, x.root_org_id
    FROM (
      SELECT r.pipeline_id, (SELECT MAX(r2.root_org_id) FROM pipeline_plugin_resolution r2 WHERE r2.pipeline_id = r.pipeline_id) AS root_org_id
      FROM pipeline_plugin_resolution r
      WHERE r.plugin_name = ${input.plugin} AND r.resolved_version = ${input.fromVersion}${pub('r.plugin_publisher')}
      UNION
      SELECT m.pipeline_id::text, (SELECT MAX(r2.root_org_id) FROM pipeline_plugin_resolution r2 WHERE r2.pipeline_id = m.pipeline_id::text) AS root_org_id
      FROM pipeline_step_manifests m
      WHERE m.plugin_name = ${input.plugin} AND m.plugin_version = ${input.fromVersion}${pub('m.plugin_publisher')}
    ) x
    JOIN pipelines p ON p.id::text = x.pipeline_id AND p.deleted_at IS NULL
    WHERE TRUE${orgFilter}
    ORDER BY pipeline_id`));
  return rowsOf<{ org_id: string; pipeline_id: string; root_org_id: string | null }>(res)
    .map((r) => ({ orgId: r.org_id, pipelineId: r.pipeline_id, rootOrgId: r.root_org_id && r.root_org_id !== r.org_id ? r.root_org_id : null }));
}

/**
 * Whether a `pipeline_remediation_upgrades` row for `rowOrgId` may be written
 * for a pipeline of `pipelineOrgId`, in a rollout scoped to `scopeOrgId` (null:
 * an instance-wide remediation). The row's org must BE the pipeline's org, and a
 * scoped rollout reaches only the scope org's own pipelines or those of a team
 * under it — confirmed against the platform org hierarchy (`ancestors`), never
 * against the root a resolution row recorded, which the candidate query reads
 * and a stale or foreign row could claim. Fail-closed: a hierarchy that cannot
 * be read THROWS (logged), so the start writes nothing and fails — the plugin
 * service retries a failed start, while a repeat of a start that did write
 * rows only re-targets them and would never add the pipeline left out.
 */
export async function rowOrgAdmits(
  input: { pipelineOrgId: string; rowOrgId: string; scopeOrgId: string | null },
  ancestors: (orgId: string) => Promise<string[]>,
): Promise<boolean> {
  const pipelineOrg = input.pipelineOrgId.toLowerCase();
  if (pipelineOrg !== input.rowOrgId.toLowerCase()) return false;
  if (input.scopeOrgId === null) return true;
  const scope = input.scopeOrgId.toLowerCase();
  if (pipelineOrg === scope) return true;
  try {
    return (await ancestors(input.pipelineOrgId)).some((a) => a.toLowerCase() === scope);
  } catch (err) {
    logger.warn('Remediation rollout start refused: org hierarchy unavailable', { orgId: input.pipelineOrgId, scopeOrgId: input.scopeOrgId, error: errorMessage(err) });
    throw err;
  }
}

/**
 * The LIVE root of `orgId` in the platform hierarchy (its farthest ancestor),
 * or null when the org is itself a root (a row's `rootOrgId` shape). A
 * scoped rollout start reads this instead of the resolution row's recorded
 * root, which goes stale when a team moves to another root. Throws (logged)
 * when the hierarchy cannot be read, failing the start whole.
 */
export async function liveRootOrg(orgId: string, ancestors: (orgId: string) => Promise<string[]>): Promise<string | null> {
  let chain: string[];
  try {
    chain = await ancestors(orgId);
  } catch (err) {
    logger.warn('Remediation rollout start refused: org hierarchy unavailable', { orgId, error: errorMessage(err) });
    throw err;
  }
  const root = chain.at(-1);
  return root && root.toLowerCase() !== orgId.toLowerCase() ? root : null;
}

/** The pipeline row (live only), cross-org. */
export async function loadPipeline(pipelineId: string): Promise<RolloutPipeline | null> {
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT id::text AS id, org_id, props, pipeline_name, remediation_upgrades FROM pipelines WHERE id = ${pipelineId}::uuid AND deleted_at IS NULL`));
  const r = rowsOf<Record<string, unknown>>(res)[0];
  if (!r) return null;
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    props: (typeof r.props === 'string' ? JSON.parse(r.props) : r.props) as Pipeline['props'],
    pipelineName: String(r.pipeline_name),
    remediationUpgrades: r.remediation_upgrades as PipelineRemediationElection,
  };
}

/**
 * False when the pipeline's runner is known unhealthy: its linked runner(s)
 * all revoked, pending or unreachable; unlinked, every runner routing could
 * discover it through (`eligibleRunners`: the org's own, then its ancestors'
 * shared ones) unhealthy. No runner at all is not "unhealthy" (routing answers
 * NO_RUNNER; the redeploy retry records it).
 */
export async function runnerHealthy(pipelineId: string, orgId: string, rootOrgId: string | null, deps: () => RunnerDeps = runnerDeps): Promise<boolean> {
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT r.status, r.health FROM pipeline_registry g JOIN pipeline_runners r ON r.id = g.runner_id
    WHERE g.pipeline_id = ${pipelineId}::uuid`));
  const runners = rowsOf<{ status: string; health: string }>(res);
  if (runners.length > 0) return runners.some((r) => r.status === 'active' && r.health === 'healthy');
  const eligible = await eligibleRunners(deps(), orgId, rootOrgId ?? undefined);
  if (eligible.length === 0) return true;
  return eligible.some((e) => e.runner.status === 'active' && e.runner.health === 'healthy');
}

/** Of `pipelineIds`, the ones with a successful run in the last {@link REMEDIATION_CANARY_RECENT_DAYS} days. */
export async function recentlySucceeded(pipelineIds: readonly string[], now: Date): Promise<Set<string>> {
  if (pipelineIds.length === 0) return new Set();
  const since = new Date(now.getTime() - REMEDIATION_CANARY_RECENT_DAYS * 86_400_000).toISOString();
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT DISTINCT pipeline_id::text AS pipeline_id FROM pipeline_events
    WHERE pipeline_id IN (${sql.join(pipelineIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND event_type = 'PIPELINE' AND status = 'SUCCEEDED' AND created_at > ${since}::timestamptz`));
  return new Set(rowsOf<{ pipeline_id: string }>(res).map((r) => r.pipeline_id));
}

/** A moved row's redeploy: pending (not yet delivered), running, or finished (or there was none). */
export type RunState = 'pending' | 'running' | 'finished';

/** The run state of every MOVED row of a remediation (see {@link RunState}). */
export async function runStates(remediationId: string): Promise<Map<string, RunState>> {
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT u.id::text AS id, u.state, rr.status AS run_status,
      EXISTS (
        SELECT 1 FROM pipeline_events e
        WHERE e.pipeline_id = u.pipeline_id AND e.event_type = 'PIPELINE'
          AND e.status IN (${terminalStatusList})
          AND e.created_at >= u.moved_at
          AND (rr.result_execution_id IS NULL OR e.execution_id IS NULL OR e.execution_id = rr.result_execution_id)
      ) AS finished
    FROM pipeline_remediation_upgrades u
    LEFT JOIN pipeline_run_requests rr ON rr.id = u.run_request_id
    WHERE u.remediation_id = ${remediationId}::uuid AND u.state IN ('moved', 'moved_pending_redeploy')`));
  const out = new Map<string, RunState>();
  const all = rowsOf<{ id: string; state: string }>(res);
  // A redeploy still being retried has not started: pending.
  const pendingRedeploy = new Set(all.filter((r) => r.state === 'moved_pending_redeploy').map((r) => r.id));
  for (const r of rowsOf<{ id: string; run_status: string | null; finished: boolean }>(res)) {
    if (pendingRedeploy.has(r.id)) out.set(r.id, 'pending');
    else if (r.run_status === null) out.set(r.id, 'finished');
    else if ((PENDING_RUN_REQUEST_STATUSES as readonly string[]).includes(r.run_status)) out.set(r.id, 'pending');
    else if (r.run_status !== 'started') out.set(r.id, 'finished');
    else out.set(r.id, r.finished ? 'finished' : 'running');
  }
  return out;
}

/**
 * Whether a moved pipeline failed on a step using the new version within the
 * rollback window: a failed action whose (stage, action) the pipeline's stored
 * step-to-plugin mapping maps to the plugin at `toVersion`; with no mapping
 * at all, any failed event of the MOVED RUN (`execution_id` = the run
 * request's `result_execution_id`) — any failed event of the pipeline only
 * when the move started no run.
 */
export async function failedOnNewVersion(row: UpgradeRow): Promise<boolean> {
  if (!row.movedAt) return false;
  const from = row.movedAt.toISOString();
  const until = new Date(row.movedAt.getTime() + REMEDIATION_ROLLBACK_WINDOW_MS).toISOString();
  const pub = row.pluginPublisher === null ? sql`m.plugin_publisher IS NULL` : sql`m.plugin_publisher = ${row.pluginPublisher}`;
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM pipeline_events e
      WHERE e.pipeline_id = ${row.pipelineId}::uuid
        AND e.status IN (${failedStatusList})
        AND COALESCE(e.completed_at, e.created_at) >= ${from}::timestamptz
        AND COALESCE(e.completed_at, e.created_at) <= ${until}::timestamptz
        AND (
          (
            NOT EXISTS (SELECT 1 FROM pipeline_step_manifests m0 WHERE m0.pipeline_id = ${row.pipelineId}::uuid)
            AND (
              NOT EXISTS (SELECT 1 FROM pipeline_run_requests rr0 WHERE rr0.id = ${row.runRequestId}::uuid)
              OR e.execution_id = (SELECT rr.result_execution_id FROM pipeline_run_requests rr WHERE rr.id = ${row.runRequestId}::uuid)
            )
          )
          OR EXISTS (
            SELECT 1 FROM pipeline_step_manifests m
            WHERE m.pipeline_id = e.pipeline_id AND m.stage_name = e.stage_name AND m.action_name = e.action_name
              AND m.plugin_name = ${row.pluginName} AND m.plugin_version = ${row.toVersion} AND ${pub}
          )
        )
    ) AS failed`));
  return rowsOf<{ failed: boolean }>(res)[0]?.failed === true;
}

/**
 * The remediations with something left to do: queued moves, runner retries
 * (an expired one is failed by the tick), moves waiting on a change request or
 * a redeploy, or moves still in their rollback window.
 */
export async function activeRemediationIds(now: Date): Promise<string[]> {
  const windowStart = new Date(now.getTime() - REMEDIATION_ROLLBACK_WINDOW_MS).toISOString();
  const res = await asSystem((tx) => tx.execute(sql`
    SELECT DISTINCT remediation_id::text AS id FROM pipeline_remediation_upgrades
    WHERE state IN ('queued', 'skipped_runner', 'waiting_change_request', 'moved_pending_redeploy')
       OR (state = 'moved' AND moved_at > ${windowStart}::timestamptz)`));
  return rowsOf<{ id: string }>(res).map((r) => r.id);
}

// -- Summary -------------------------------------------------------------------------

/** Zero for every state. */
export function emptyCounts(): StateCounts {
  return Object.fromEntries(PIPELINE_REMEDIATION_UPGRADE_STATES.map((s) => [s, 0])) as StateCounts;
}

export function countStates(rows: readonly UpgradeRow[]): StateCounts {
  const counts = emptyCounts();
  for (const r of rows) counts[r.state] += 1;
  return counts;
}

/** The `error` a cancel stamps on the rows it supersedes (other supersedes — a deleted pipeline, a stale plan — keep their own). */
export const CANCELLED_ERROR = 'cancelled';

/** Why the rollout is paused, or null. */
export function pauseReason(rows: readonly UpgradeRow[]): RemediationRolloutPauseReason | null {
  if (rows.some((r) => r.state === 'rollback_blocked' && r.error === 'previous_version_deleted')) return 'rollback_target_deleted';
  if (rows.some((r) => r.wave === 0 && r.state === 'rolled_back')) return 'canary_failed';
  if (rows.filter((r) => r.state === 'rolled_back').length >= REMEDIATION_MAX_ROLLBACKS) return 'rollbacks';
  return null;
}

const WAVE_STATES: ReadonlySet<PipelineRemediationUpgradeState> = new Set(['moved', 'moved_pending_redeploy', 'failed', 'rolled_back', 'rollback_blocked']);

/** The highest wave anything moved in (−1 when none yet). */
function currentWave(rows: readonly UpgradeRow[]): number {
  return rows.reduce((max, r) => (r.wave !== null && WAVE_STATES.has(r.state) ? Math.max(max, r.wave) : max), -1);
}

/**
 * Whether wave `index` lets the next one start: the canary when each of its
 * runs finished (or the window ran out); a batch once its runs have started.
 */
function waveSettled(rows: readonly UpgradeRow[], index: number, runs: ReadonlyMap<string, RunState>, now: Date): boolean {
  // A move whose redeploy is still being retried never settles its wave (the retry cap ends it).
  if (rows.some((r) => r.wave === index && r.state === 'moved_pending_redeploy')) return false;
  const wave = rows.filter((r) => r.wave === index && r.state === 'moved');
  if (index === 0) {
    return wave.every((r) => runs.get(r.id) === 'finished'
      || (r.movedAt !== null && now.getTime() - r.movedAt.getTime() > REMEDIATION_ROLLBACK_WINDOW_MS));
  }
  return wave.every((r) => runs.get(r.id) !== 'pending');
}

/** The rollout summary derived from the rows (the shape the plugin service stores). */
export function summarize(rows: readonly UpgradeRow[], toVersion: string, runs: ReadonlyMap<string, RunState>, now: Date): RemediationRolloutSummary {
  const counts = countStates(rows);
  const paused = pauseReason(rows);
  const wave = currentWave(rows);
  const queued = counts.queued;
  // Not finished: waiting on another change request, or on a redeploy retry.
  const unfinished = queued + counts.waiting_change_request + counts.moved_pending_redeploy;
  let status: RemediationRolloutStatus;
  if (queued === 0 && rows.some((r) => r.state === 'superseded' && r.error === CANCELLED_ERROR)) status = 'cancelled';
  else if (paused) status = 'paused';
  else if (unfinished === 0 && (wave < 0 || waveSettled(rows, wave, runs, now))) status = 'done';
  else if (wave < 0) status = 'pending';
  else if (wave === 0) status = 'canary';
  else status = 'batches';

  const waves: RemediationRolloutWave[] = [];
  for (let i = 0; i <= wave; i += 1) {
    const inWave = rows.filter((r) => r.wave === i && WAVE_STATES.has(r.state));
    if (inWave.length === 0) continue;
    const started = inWave.map((r) => r.movedAt ?? r.updatedAt).sort((a, b) => a.getTime() - b.getTime());
    const failed = inWave.some((r) => r.state === 'rolled_back' || r.state === 'rollback_blocked');
    const settled = waveSettled(rows, i, runs, now);
    waves.push({
      index: i,
      kind: i === 0 ? 'canary' : 'batch',
      pipelineIds: inWave.map((r) => r.pipelineId).slice(0, REMEDIATION_BATCH_SIZE),
      startedAt: started[0]!.toISOString(),
      finishedAt: settled ? started[started.length - 1]!.toISOString() : null,
      outcome: failed ? 'failed' : settled ? 'succeeded' : 'running',
    });
  }
  return {
    status,
    toVersion,
    waves,
    counts: {
      eligible: rows.length - counts.skipped_opt_out,
      proposed: counts.proposed,
      changeRequested: counts.change_requested,
      moved: counts.moved,
      failed: counts.failed,
      rolledBack: counts.rolled_back,
      skippedOptOut: counts.skipped_opt_out,
      skippedRunner: counts.skipped_runner,
      waitingChangeRequest: counts.waiting_change_request,
      movedPendingRedeploy: counts.moved_pending_redeploy,
    },
    ...(paused && status === 'paused' ? { pausedReason: paused } : {}),
    updatedAt: now.toISOString(),
  };
}

/** The rollback events of the last day (the plugin side dedups them). */
export function recentEvents(rows: readonly UpgradeRow[], now: Date): RolloutEvent[] {
  const since = now.getTime() - REMEDIATION_ROLLBACK_WINDOW_MS - ROLLOUT_TICK_MS * 60;
  return rows
    .filter((r) => (r.state === 'rolled_back' || r.state === 'rollback_blocked') && r.rolledBackAt && r.rolledBackAt.getTime() >= since)
    .slice(0, 500)
    .map((r) => ({
      kind: r.state === 'rolled_back' ? 'rolled_back' as const : 'rollback_blocked' as const,
      orgId: r.orgId,
      pipelineId: r.pipelineId,
      fromVersion: r.toVersion,
      toVersion: r.rolledBackTo ?? r.fromVersion,
      at: r.rolledBackAt!.toISOString(),
    }));
}

// -- The engine ------------------------------------------------------------------------

/** The state a pipeline starts in (or is re-resolved to before its move), and its effective mode. */
interface Placement {
  state: PipelineRemediationUpgradeState;
  mode: UpgradeRow['mode'];
  error: string | null;
  requestChange: PinnedInstall | null;
}

/** An install the pipeline's org inherits (a team's install is its ROOT's row): only the root's own rollout moves it. */
const inheritedInstall = (install: PinnedInstall | null, orgId: string): boolean => !!install && install.orgId.toLowerCase() !== orgId.toLowerCase();

function place(mode: PluginRemediationRollout, plan: MovePlan, isTeam: boolean, orgId: string): Placement {
  if (mode === 'off') return { state: 'skipped_opt_out', mode, error: null, requestChange: null };
  if (plan.kind === 'not_admitted') return { state: 'failed', mode, error: 'not_admitted', requestChange: null };
  if (plan.kind === 'stale') return { state: 'superseded', mode, error: 'not_using_version', requestChange: null };
  // An install change: gated, or proposed — a change request on the install, never a move.
  if (plan.kind === 'install_pin' && plan.install && (plan.install.gated || mode === 'propose')) {
    return { state: 'change_requested', mode, error: null, requestChange: plan.install };
  }
  if (mode === 'propose') return { state: 'proposed', mode, error: null, requestChange: null };
  // Teams only get proposals for pins in their own pipelines, and never move an
  // install they inherit (applied from the page once the root's install moved).
  if (isTeam && (plan.kind === 'step_pin' || inheritedInstall(plan.install, orgId))) return { state: 'proposed', mode: 'propose', error: null, requestChange: null };
  // The install it would move has another change pending: only this pipeline waits.
  if (plan.install?.pendingChange) return { state: 'waiting_change_request', mode, error: INSTALL_CHANGE_PENDING, requestChange: null };
  return { state: 'queued', mode, error: null, requestChange: null };
}

/** A successful move's state: `moved`, or `moved_pending_redeploy` when its redeploy did not start. */
const movedState = (result: MoveResult & { ok: true }): 'moved' | 'moved_pending_redeploy' =>
  (result.runRequestId === null && result.note === REDEPLOY_FAILED ? 'moved_pending_redeploy' : 'moved');

/** The plan of a pipeline that is never planned (opted out). */
const NO_PLAN: MovePlan = { kind: 'redeploy', steps: [], install: null };

const REF_OF = (row: UpgradeRow): RemediationRef => ({
  remediationId: row.remediationId, plugin: row.pluginName, publisher: row.pluginPublisher, fromVersion: row.fromVersion, toVersion: row.toVersion,
});

/** The rollout engine over `deps`. */
export function createRolloutEngine(deps: RolloutDeps) {
  /** The last summary reported per remediation (this replica; a new leader re-reports once — the report is idempotent). */
  const lastReported = new Map<string, string>();

  async function report(remediationId: string, rows: readonly UpgradeRow[], toVersion: string, force: boolean): Promise<void> {
    const now = deps.now();
    const summary = summarize(rows, toVersion, await runStates(remediationId), now);
    const events = recentEvents(rows, now);
    const key = JSON.stringify({ ...summary, updatedAt: null, events: events.length });
    if (!force && lastReported.get(remediationId) === key) return;
    const outcome = await deps.report(remediationId, { summary, events });
    if (outcome === 'ok') lastReported.set(remediationId, key);
    if (outcome === 'unknown') {
      // The plugin service no longer knows the remediation: drop the rollout.
      logger.warn('Remediation unknown to the plugin service; dropping its rollout', { remediationId });
      await cancel(remediationId);
      lastReported.delete(remediationId);
    }
  }

  /** Create (or re-target) the rows of a rollout. Idempotent per remediation. */
  async function start(remediationId: string, input: StartRolloutInput): Promise<{ remediationId: string; created: boolean; orgDefault: PluginRemediationRollout | null; counts: StateCounts }> {
    const settingsOf = settingsReader((o, r) => deps.settings(o, r ?? null));
    const orgDefault = input.orgId ? (await settingsOf(input.orgId, null)).orgDefault : null;
    const ref: RemediationRef = { remediationId, plugin: input.plugin, publisher: input.publisher, fromVersion: input.fromVersion, toVersion: input.toVersion };
    const existing = await loadRows(remediationId);
    const requested = new Set<string>();

    // A scoped rollout reads each org's root from the LIVE hierarchy (one fetch
    // per org per start), never the root a resolution row recorded: a team
    // moved to another root would otherwise take its old root's settings and
    // be planned under it. An official (instance-wide) rollout keeps the
    // recorded root and never reads the hierarchy.
    const chains = new Map<string, Promise<string[]>>();
    const ancestorsOf = (orgId: string): Promise<string[]> => {
      const key = orgId.toLowerCase();
      if (!chains.has(key)) chains.set(key, deps.ancestors(orgId));
      return chains.get(key)!;
    };
    const rootFor = (orgId: string, recorded: () => Promise<string | null>): Promise<string | null> =>
      input.orgId === null ? recorded() : liveRootOrg(orgId, ancestorsOf);

    const placeFor = async (orgId: string, pipelineId: string, rootOrgId: string | null, loaded?: RolloutPipeline): Promise<Placement | null> => {
      const pipeline = loaded ?? await loadPipeline(pipelineId);
      if (!pipeline) return null;
      const settings = await settingsOf(orgId, rootOrgId);
      const resolved = effectiveRollout(pipeline.remediationUpgrades, settings);
      // An opted-out pipeline is never planned: it is skipped whatever it would take.
      const plan = resolved.mode === 'off' ? NO_PLAN : await deps.plan(pipeline, rootOrgId, ref);
      const placement = place(resolved.mode, plan, !!rootOrgId, orgId);
      if (placement.requestChange && !requested.has(placement.requestChange.id)) {
        requested.add(placement.requestChange.id);
        await deps.requestInstallChange(placement.requestChange, ref);
      }
      return placement;
    };

    if (existing.length > 0) {
      // A repeat start. A different toVersion (the owner's own clean version)
      // re-targets every OPEN row at it; moved / rolled-back rows stay as they are.
      const open: readonly PipelineRemediationUpgradeState[] = OPEN_STATES;
      const retarget = existing.filter((r) => r.toVersion !== input.toVersion && open.includes(r.state));
      // Every root is read before any row is patched: an unreadable hierarchy
      // fails the start with nothing re-targeted.
      const roots = new Map<string, string | null>();
      for (const row of retarget) roots.set(row.id, await rootFor(row.orgId, async () => row.rootOrgId));
      for (const row of retarget) {
        const rootOrgId = roots.get(row.id) ?? null;
        const placement = await placeFor(row.orgId, row.pipelineId, rootOrgId);
        await patchRow(row.id, placement
          ? { toVersion: input.toVersion, rootOrgId, state: placement.state, mode: placement.mode, error: placement.error, wave: null }
          : { state: 'superseded', error: 'pipeline_deleted' }, open);
      }
      return { remediationId, created: false, orgDefault, counts: countStates(await loadRows(remediationId)) };
    }

    // The rows are written as the system: check every candidate's org against
    // its pipeline (and the rollout's scope) FIRST, before anything is planned,
    // requested or written — an unreadable hierarchy fails the start whole.
    // A scoped rollout's candidates are the pipelines of the scope org and its
    // LIVE descendants (an unreadable hierarchy throws: nothing is written).
    const scopeOrgIds = input.orgId === null ? null : [input.orgId, ...await deps.descendants(input.orgId)];
    const admitted: Array<{ c: Awaited<ReturnType<typeof rolloutCandidates>>[number]; pipeline: RolloutPipeline; rootOrgId: string | null }> = [];
    for (const c of await rolloutCandidates(input, scopeOrgIds)) {
      const pipeline = await loadPipeline(c.pipelineId);
      if (!pipeline) continue;
      if (!await rowOrgAdmits({ pipelineOrgId: pipeline.orgId, rowOrgId: c.orgId, scopeOrgId: input.orgId }, ancestorsOf)) {
        logger.warn('Remediation row refused: pipeline outside the rollout org', { remediationId, pipelineId: c.pipelineId, orgId: c.orgId, scopeOrgId: input.orgId });
        continue;
      }
      admitted.push({ c, pipeline, rootOrgId: await rootFor(pipeline.orgId, async () => c.rootOrgId) });
    }
    // Every candidate is planned before any row is written, and the rows go in
    // one transaction: a start that fails part-way writes nothing, so its retry
    // is a fresh start over every candidate (a repeat start that finds rows only
    // re-targets them and would never add a pipeline a partial start left out).
    // A change request issued before the failure is a no-op when the retry
    // issues it again (it is written only while the install has none pending).
    const placed: Array<{ c: (typeof admitted)[number]['c']; rootOrgId: string | null; placement: Placement }> = [];
    for (const { c, pipeline, rootOrgId } of admitted) {
      const placement = await placeFor(c.orgId, c.pipelineId, rootOrgId, pipeline);
      if (placement && placement.state !== 'superseded') placed.push({ c, rootOrgId, placement });
    }
    if (placed.length > 0) {
      await asSystem(async (tx) => {
        for (const { c, rootOrgId, placement } of placed) {
          // Guarded in SQL too: the row is inserted only while the pipeline is
          // live and still belongs to the row's org.
          await tx.execute(sql`
            INSERT INTO pipeline_remediation_upgrades (org_id, root_org_id, remediation_id, pipeline_id, plugin_name, plugin_publisher, from_version, to_version, mode, state, error)
            SELECT ${c.orgId}, ${rootOrgId}, ${remediationId}::uuid, p.id, ${input.plugin}, ${input.publisher}, ${input.fromVersion}, ${input.toVersion},
                   ${placement.mode}, ${placement.state}, ${placement.error}
            FROM pipelines p
            WHERE p.id = ${c.pipelineId}::uuid AND p.deleted_at IS NULL AND lower(p.org_id) = ${c.orgId.toLowerCase()}
            ON CONFLICT (remediation_id, pipeline_id) DO NOTHING`);
        }
      });
    }
    const rows = await loadRows(remediationId);
    await report(remediationId, rows, input.toVersion, true).catch((err) => logger.warn('Rollout report failed', { remediationId, error: errorMessage(err) }));
    return { remediationId, created: true, orgDefault, counts: countStates(rows) };
  }

  /** Stop a rollout: queued moves dropped, open proposals superseded; moved pipelines stay. */
  async function cancel(remediationId: string): Promise<boolean> {
    const rows = await loadRows(remediationId);
    if (rows.length === 0) return false;
    await asSystem((tx) => tx.execute(sql`
      UPDATE pipeline_remediation_upgrades SET state = 'superseded', error = ${CANCELLED_ERROR}, updated_at = now()
      WHERE remediation_id = ${remediationId}::uuid AND state IN (${stateList(OPEN_STATES)})`));
    return true;
  }

  /**
   * Move one row (apply mode), re-resolving its effective mode first. Answers
   * the row's new state.
   */
  async function moveOne(row: UpgradeRow, wave: number): Promise<PipelineRemediationUpgradeState> {
    const from = MOVABLE_STATES;
    const pipeline = await loadPipeline(row.pipelineId);
    if (!pipeline) {
      await patchRow(row.id, { state: 'superseded', error: 'pipeline_deleted' }, from);
      return 'superseded';
    }
    const rootOrgId = row.rootOrgId;
    const resolved = effectiveRollout(pipeline.remediationUpgrades, await deps.settings(row.orgId, rootOrgId));
    const ref = REF_OF(row);
    const plan = resolved.mode === 'off' ? NO_PLAN : await deps.plan(pipeline, rootOrgId, ref);
    const placement = place(resolved.mode, plan, !!rootOrgId, row.orgId);
    if (placement.state !== 'queued') {
      if (placement.requestChange) await deps.requestInstallChange(placement.requestChange, ref);
      await patchRow(row.id, { state: placement.state, mode: placement.mode, error: placement.error }, from);
      return placement.state;
    }
    if (!await runnerHealthy(row.pipelineId, row.orgId, rootOrgId)) {
      await patchRow(row.id, { state: 'skipped_runner', wave, error: 'runner_unhealthy' }, from);
      return 'skipped_runner';
    }
    const result = await deps.move({ row, pipeline, rootOrgId, ref, plan, actor: REMEDIATION_ACTOR });
    if (!result.ok) {
      // Another change request landed on the install since the plan: wait for it, don't fail.
      if (result.error === INSTALL_CHANGE_PENDING) {
        await patchRow(row.id, { state: 'waiting_change_request', mode: 'apply', error: INSTALL_CHANGE_PENDING }, from);
        return 'waiting_change_request';
      }
      await patchRow(row.id, { state: 'failed', mode: 'apply', wave, error: result.error }, from);
      return 'failed';
    }
    const state = movedState(result);
    await patchRow(row.id, {
      state, mode: 'apply', wave, movedAt: deps.now(), runRequestId: result.runRequestId, error: state === 'moved' ? (result.note ?? null) : `${REDEPLOY_FAILED}:1`,
    }, from);
    return state;
  }

  /**
   * Retry the redeploy of a moved_pending_redeploy row (due every
   * {@link REDEPLOY_RETRY_MS}); after {@link REDEPLOY_MAX_ATTEMPTS} it ends `failed`.
   */
  async function retryRedeploy(row: UpgradeRow): Promise<PipelineRemediationUpgradeState> {
    const from = ['moved_pending_redeploy'] as const;
    const pipeline = await loadPipeline(row.pipelineId);
    if (!pipeline) {
      await patchRow(row.id, { state: 'superseded', error: 'pipeline_deleted' }, from);
      return 'superseded';
    }
    const attempts = redeployAttempts(row.error) + 1;
    const result = await deps.redeploy({ row, pipeline, rootOrgId: row.rootOrgId });
    if (result.ok && movedState(result) === 'moved') {
      await patchRow(row.id, { state: 'moved', runRequestId: result.runRequestId, error: null }, from);
      return 'moved';
    }
    if (attempts >= REDEPLOY_MAX_ATTEMPTS) {
      await patchRow(row.id, { state: 'failed', error: 'redeploy_retries_exhausted' }, from);
      return 'failed';
    }
    await patchRow(row.id, { error: `${REDEPLOY_FAILED}:${attempts}` }, from);
    return 'moved_pending_redeploy';
  }

  /**
   * A waiting_change_request row whose install's change request was decided:
   * approved (the plan no longer moves that install) → queued, moved by the
   * next wave as planned; rejected (still pinned to the flagged version) →
   * `dismissed`, `change_request_rejected`. Still pending → unchanged.
   */
  async function resumeWaiting(row: UpgradeRow): Promise<PipelineRemediationUpgradeState> {
    const from = ['waiting_change_request'] as const;
    const pipeline = await loadPipeline(row.pipelineId);
    if (!pipeline) {
      await patchRow(row.id, { state: 'superseded', error: 'pipeline_deleted' }, from);
      return 'superseded';
    }
    const plan = await deps.plan(pipeline, row.rootOrgId, REF_OF(row));
    if (plan.install?.pendingChange) return 'waiting_change_request';
    if (plan.kind === 'install_pin') {
      await patchRow(row.id, { state: 'dismissed', error: 'change_request_rejected' }, from);
      return 'dismissed';
    }
    await patchRow(row.id, { state: 'queued', error: null }, from);
    return 'queued';
  }

  /** Roll one moved row back (see the module doc for when it is refused). */
  async function rollbackOne(row: UpgradeRow): Promise<PipelineRemediationUpgradeState> {
    const now = deps.now();
    const rootOrgId = row.rootOrgId;
    const target = await deps.rollbackTarget(row, rootOrgId);
    const audit = (outcome: 'success' | 'failure', extra: Record<string, unknown>) => recordAudit({
      action: 'plugin.remediation.rolled_back',
      actorId: actorId({ userId: SYSTEM_PLUGIN_REMEDIATION }),
      orgId: row.orgId,
      targetType: 'plugin_remediation',
      targetId: row.remediationId,
      ...(outcome === 'failure' ? { outcome } : {}),
      details: { pipelineId: row.pipelineId, plugin: row.pluginPublisher ? `${row.pluginPublisher}/${row.pluginName}` : row.pluginName, fromVersion: row.toVersion, toVersion: row.fromVersion, ...extra },
    });
    if (!target.ok) {
      await patchRow(row.id, { state: 'rollback_blocked', rolledBackAt: now, error: target.reason }, ['moved']);
      audit('failure', { reason: target.reason });
      return 'rollback_blocked';
    }
    const pipeline = await loadPipeline(row.pipelineId);
    if (!pipeline) {
      await patchRow(row.id, { state: 'superseded', error: 'pipeline_deleted' }, ['moved']);
      return 'superseded';
    }
    // The reverse move: every step now on the fix goes back to the previous version (pinned).
    const back: RemediationRef = { ...REF_OF(row), fromVersion: row.toVersion, toVersion: row.fromVersion };
    const plan = await deps.plan(pipeline, rootOrgId, back, { pinRanges: true });
    const result = await deps.move({ row, pipeline, rootOrgId, ref: back, plan, actor: REMEDIATION_ACTOR, rollback: true });
    if (!result.ok) {
      await patchRow(row.id, { state: 'rollback_blocked', rolledBackAt: now, error: 'rollback_refused' }, ['moved']);
      audit('failure', { reason: 'rollback_refused' });
      return 'rollback_blocked';
    }
    await patchRow(row.id, { state: 'rolled_back', rolledBackAt: now, rolledBackTo: row.fromVersion, runRequestId: result.runRequestId, error: null }, ['moved']);
    audit('success', {});
    return 'rolled_back';
  }

  /** One pass over one remediation: rollbacks, then (unless paused) the next wave, then a report. */
  async function tickOne(remediationId: string): Promise<RemediationRolloutSummary | null> {
    const now = deps.now();
    let rows = await loadRows(remediationId);
    if (rows.length === 0) return null;
    let rolledBack = false;

    for (const row of rows.filter((r) => r.state === 'moved' && r.movedAt && now.getTime() - r.movedAt.getTime() <= REMEDIATION_ROLLBACK_WINDOW_MS)) {
      if (await failedOnNewVersion(row)) {
        await rollbackOne(row);
        rolledBack = true;
      }
    }
    if (rolledBack) rows = await loadRows(remediationId);

    // Runner retries that ran out, redeploy retries that are due, and change requests that were decided.
    let changed = false;
    const expiredBefore = now.getTime() - RUNNER_RETRY_MAX_AGE_MS;
    for (const row of rows.filter((r) => r.state === 'skipped_runner' && r.createdAt.getTime() <= expiredBefore)) {
      changed = await patchRow(row.id, { state: 'failed', error: 'runner_unhealthy_expired' }, ['skipped_runner']) || changed;
    }
    const redeployBefore = now.getTime() - REDEPLOY_RETRY_MS;
    for (const row of rows.filter((r) => r.state === 'moved_pending_redeploy' && r.updatedAt.getTime() <= redeployBefore)) {
      try {
        await retryRedeploy(row);
        changed = true;
      } catch (err) {
        logger.warn('Remediation redeploy retry failed', { remediationId, pipelineId: row.pipelineId, error: errorMessage(err) });
      }
    }
    for (const row of rows.filter((r) => r.state === 'waiting_change_request')) {
      try {
        if (await resumeWaiting(row) !== 'waiting_change_request') changed = true;
      } catch (err) {
        logger.warn('Remediation change-request resume failed', { remediationId, pipelineId: row.pipelineId, error: errorMessage(err) });
      }
    }
    if (changed) rows = await loadRows(remediationId);

    const toVersion = rows.find((r) => r.state === 'queued')?.toVersion ?? rows[rows.length - 1]!.toVersion;
    const runs = await runStates(remediationId);
    const summary = summarize(rows, toVersion, runs, now);
    const blocked = summary.status === 'paused' || summary.status === 'cancelled';
    const wave = currentWave(rows);
    if (!blocked && (wave < 0 || waveSettled(rows, wave, runs, now))) {
      const retryBefore = now.getTime() - RUNNER_RETRY_MS;
      const eligible = [
        ...rows.filter((r) => r.state === 'queued'),
        ...rows.filter((r) => r.state === 'skipped_runner' && r.updatedAt.getTime() <= retryBefore),
      ];
      if (eligible.length > 0) {
        const index = wave + 1;
        let picked: UpgradeRow[];
        if (index === 0) {
          const recent = await recentlySucceeded(eligible.map((r) => r.pipelineId), now);
          picked = [...eligible].sort((a, b) => Number(recent.has(b.pipelineId)) - Number(recent.has(a.pipelineId))).slice(0, REMEDIATION_CANARY_SIZE);
        } else {
          picked = eligible.slice(0, REMEDIATION_BATCH_SIZE);
        }
        let movedAny = false;
        for (const row of picked) {
          try {
            if (await moveOne(row, index) === 'moved') movedAny = true;
          } catch (err) {
            logger.warn('Remediation move failed', { remediationId, pipelineId: row.pipelineId, error: errorMessage(err) });
            await patchRow(row.id, { state: 'failed', wave: index, error: 'internal_error' }, MOVABLE_STATES);
          }
        }
        // A wave that moved nothing (all skipped / re-resolved) never blocks the next pass.
        if (!movedAny) logger.info('Remediation wave moved nothing', { remediationId, wave: index });
        rows = await loadRows(remediationId);
      }
    }
    await report(remediationId, rows, toVersion, false).catch((err) => logger.warn('Rollout report failed', { remediationId, error: errorMessage(err) }));
    return summarize(rows, toVersion, await runStates(remediationId), now);
  }

  /** One pass over every active remediation (the worker's tick). */
  async function tick(): Promise<void> {
    for (const id of await activeRemediationIds(deps.now())) {
      try {
        await tickOne(id);
      } catch (err) {
        logger.warn('Remediation rollout tick failed', { remediationId: id, error: errorMessage(err) });
      }
    }
  }

  /**
   * Apply one PROPOSED row from the pipeline page (actor = the user, under
   * their tenant scope): the same plan and write path as a rollout move. A
   * listing install the plan would move along is moved only with `moveInstall`
   * (the caller may change installs, plugins:install) and only when it is the
   * pipeline org's own; otherwise just the step pins move.
   */
  async function applyProposal(row: UpgradeRow, pipeline: RolloutPipeline, actor: ApplyActor, rootOrgId: string | null, opts: { moveInstall?: boolean } = {}): Promise<MoveResult> {
    const ref = REF_OF(row);
    const planned = await deps.plan(pipeline, rootOrgId, ref);
    const plan = planned.install && (!opts.moveInstall || inheritedInstall(planned.install, pipeline.orgId)) && planned.kind !== 'install_pin'
      ? { ...planned, install: null }
      : planned;
    if (plan.kind === 'not_admitted' || plan.kind === 'stale') return { ok: false, error: plan.kind };
    if (plan.kind === 'install_pin') return { ok: false, error: 'install_change_needed' };
    const result = await deps.move({ row, pipeline, rootOrgId, ref, plan, actor });
    if (result.ok) {
      const state = movedState(result);
      await patchRow(row.id, {
        state, mode: 'propose', movedAt: deps.now(), runRequestId: result.runRequestId, error: state === 'moved' ? (result.note ?? null) : `${REDEPLOY_FAILED}:1`,
      }, ['proposed']);
    }
    return result;
  }

  return { start, cancel, tick, tickOne, applyProposal, moveOne, rollbackOne, retryRedeploy, resumeWaiting };
}

export type RolloutEngine = ReturnType<typeof createRolloutEngine>;

// -- The real dependencies --------------------------------------------------------------

function declaredVersion(step: PluginStepRef): string | null {
  return typeof step.filter?.version === 'string' && step.filter.version.trim() !== '' ? step.filter.version.trim() : null;
}

/** The listing install that pins `ref.fromVersion` for `orgId` (own or inherited from its root), or null. */
async function pinnedInstall(orgId: string, rootOrgId: string | null, ref: RemediationRef): Promise<PinnedInstall | null> {
  if (!ref.publisher) return null;
  const scope = { orgId, ...(rootOrgId ? { rootOrgId } : {}) };
  const states = await asSystem((tx) => orgListingStates(drizzleListingSource(tx as never), scope, { names: [ref.plugin] }));
  const state = states.find((s) => s.publisher.handle === ref.publisher);
  if (!state || 'code' in state.mode || state.mode.kind !== 'explicit') return null;
  const install = state.mode.install;
  if (install.versionPolicy !== 'pinned' || install.pinnedVersion !== ref.fromVersion) return null;
  return {
    id: install.id,
    orgId: install.orgId,
    gated: state.policy.requireApprovalTiers.includes(state.publisher.tier),
    ...(await installHasPendingChange(install.id) ? { pendingChange: true } : {}),
  };
}

/** Whether install `id` has a change request pending (anyone's). */
export async function installHasPendingChange(id: string): Promise<boolean> {
  const res = await asSystem((tx) => tx.execute(sql`SELECT pending_change IS NOT NULL AS pending FROM plugin_installs WHERE id = ${id}::uuid`));
  return rowsOf<{ pending: boolean }>(res)[0]?.pending === true;
}

/**
 * What moving `pipeline` from `ref.fromVersion` to `ref.toVersion` takes (see
 * {@link MovePlan}). With `pinRanges` (a rollback), a range / unversioned step
 * on `fromVersion` is pinned exactly to `toVersion` too.
 */
export async function planMove(pipeline: Pick<RolloutPipeline, 'orgId' | 'props'>, rootOrgId: string | null, ref: RemediationRef, opts: { pinRanges?: boolean } = {}): Promise<MovePlan> {
  const parentOrgId = rootOrgId ?? undefined;
  const exactSteps: StepUpgrade[] = [];
  const rangeSteps: StepUpgrade[] = [];
  let admitted = false;
  for (const step of collectPluginSteps(pipeline.props)) {
    if (managedToolchainRefName(step)) continue;
    const parsed = PluginFilterSchema.safeParse(pluginLookupFilter(step));
    if (!parsed.success) continue;
    const resolution = await resolveContractPlugin(parsed.data as Partial<PluginFilter>, pipeline.orgId, parentOrgId);
    if (!resolution || !('plugin' in resolution)) continue;
    const p = resolution.plugin;
    if (p.name !== ref.plugin || (p.publisher ?? null) !== ref.publisher) continue;
    if (p.version === ref.toVersion) { admitted = true; continue; }
    if (p.version !== ref.fromVersion) continue;
    const declared = declaredVersion(step);
    const exact = declared !== null && !isVersionRange(declared);
    (exact ? exactSteps : rangeSteps).push({
      stepKey: step.label,
      path: step.path,
      plugin: p.publisher ? `${p.publisher}/${p.name}` : p.name,
      publisher: p.publisher,
      declaredVersion: declared,
      pin: declared === null ? 'none' : exact ? 'exact' : 'range',
      currentVersion: p.version,
      reason: { flagged: false, kev: 0, criticalFixable: 0, highFixable: 0 },
      suggestedInPin: ref.toVersion,
      suggestedLatest: ref.toVersion,
      apply: { version: ref.toVersion, widenVersion: ref.toVersion },
    });
  }
  // A range / unversioned step on `fromVersion` is held there by a pinned
  // install (a listing) — the install moves — or by a range that excludes the
  // fix. A rollback with no install to move back pins such steps instead.
  const found = rangeSteps.length > 0 ? await pinnedInstall(pipeline.orgId, rootOrgId, ref) : null;
  // A rollback never moves an install the pipeline's org inherits (the root's
  // row, shared by its other pipelines and teams): its own steps are pinned.
  const install = opts.pinRanges && inheritedInstall(found, pipeline.orgId) ? null : found;
  const steps = install || !opts.pinRanges ? exactSteps : [...exactSteps, ...rangeSteps];
  const kind: MovePlan['kind'] = steps.length > 0 ? 'step_pin'
    : install ? 'install_pin'
      : admitted ? 'redeploy'
        : rangeSteps.length > 0 ? 'not_admitted' : 'stale';
  return { kind, steps, install };
}

/**
 * {@link planMove} as the engine's `plan`: under the caller's tenant scope
 * when there is one (a user's proposal apply), else — a start from the plugin
 * service's internal call, the rollout worker — sysadmin-scoped in the
 * pipeline's org, as {@link moveReal} scopes a system move. Unscoped, the
 * contract resolver's `withTenantTx` throws in strict tenant mode. That scope
 * has no user, so the resolver does NOT lift the private-draft rung for it
 * (plugin-contract-check `viewerFilter`): no member's private draft is planned.
 */
function planInScope(...args: Parameters<typeof planMove>): Promise<MovePlan> {
  if (getTenantContext()) return planMove(...args);
  const [pipeline, rootOrgId] = args;
  return runWithTenantContext({ orgId: pipeline.orgId, isSuperAdmin: true, ...(rootOrgId ? { parentOrgId: rootOrgId } : {}) }, () => planMove(...args));
}

/**
 * Move a pinned install's pin `from` → `to` (guarded on the pin; a no-op when
 * it already reads `to`): `moved`, `pending` (another change request holds the
 * install) or `changed` (it no longer pins `from`).
 */
export async function moveInstallPin(install: PinnedInstall, ref: RemediationRef, actor: ApplyActor): Promise<'moved' | 'pending' | 'changed'> {
  const res = await asSystem((tx) => tx.execute(sql`
    UPDATE plugin_installs SET pinned_version = ${ref.toVersion}, resolved_version = NULL, updated_at = now()
    WHERE id = ${install.id}::uuid AND version_policy = 'pinned' AND pinned_version = ${ref.fromVersion}
      AND status = 'active' AND pending_change IS NULL
    RETURNING id`));
  if (rowsOf(res).length > 0) {
    recordAudit({
      action: 'plugin.install.upgrade',
      actorId: actorId({ userId: actor.userId }),
      orgId: install.orgId,
      targetType: 'plugin-install',
      targetId: install.id,
      details: {
        listing: `${ref.publisher}/${ref.plugin}`,
        from: { versionPolicy: 'pinned', version: ref.fromVersion },
        to: { versionPolicy: 'pinned', version: ref.toVersion },
        remediationId: ref.remediationId,
      },
    });
    return 'moved';
  }
  const now = await asSystem((tx) => tx.execute(sql`SELECT pinned_version, pending_change IS NOT NULL AS pending FROM plugin_installs WHERE id = ${install.id}::uuid`));
  const current = rowsOf<{ pinned_version: string | null; pending: boolean }>(now)[0];
  if (current?.pinned_version === ref.toVersion) return 'moved';
  return current?.pending ? 'pending' : 'changed';
}

/**
 * Open an install change request (the install's ONE pending change) to move
 * its pin to the fix — only while the install is still pinned to the flagged
 * version (moved meanwhile → nothing is requested).
 */
export async function requestInstallChange(install: PinnedInstall, ref: RemediationRef): Promise<void> {
  const change = { version: ref.toVersion, versionPolicy: 'pinned', requestedBy: SYSTEM_PLUGIN_REMEDIATION, requestedAt: new Date().toISOString(), note: `Security fix (remediation ${ref.remediationId})` };
  const res = await asSystem((tx) => tx.execute(sql`
    UPDATE plugin_installs SET pending_change = ${JSON.stringify(change)}::jsonb, updated_at = now()
    WHERE id = ${install.id}::uuid AND status = 'active' AND pending_change IS NULL
      AND version_policy = 'pinned' AND pinned_version = ${ref.fromVersion}
    RETURNING id`));
  if (rowsOf(res).length === 0) return;
  recordAudit({
    action: 'plugin.install.change-request',
    actorId: actorId({ userId: SYSTEM_PLUGIN_REMEDIATION }),
    orgId: install.orgId,
    targetType: 'plugin-install',
    targetId: install.id,
    details: {
      listing: `${ref.publisher}/${ref.plugin}`,
      from: { versionPolicy: 'pinned', version: ref.fromVersion },
      to: { versionPolicy: 'pinned', version: ref.toVersion },
      remediationId: ref.remediationId,
    },
  });
}

/** The real move: install pin, then step pins through the apply path (or a redeploy alone). */
async function moveReal(input: Parameters<RolloutDeps['move']>[0]): Promise<MoveResult> {
  const { row, pipeline, rootOrgId, ref, plan, actor } = input;
  const orgId = pipeline.orgId;
  const parentOrgId = rootOrgId ?? undefined;
  // A system move runs sysadmin-scoped in the pipeline's org (a private
  // pipeline has no viewer to match); a user's proposal apply keeps the
  // caller's own tenant scope.
  const asActor = <T>(fn: () => Promise<T>): Promise<T> => (actor.userId === SYSTEM_PLUGIN_REMEDIATION
    ? runWithTenantContext({ orgId, isSuperAdmin: true, ...(parentOrgId ? { parentOrgId } : {}) }, fn)
    : fn());
  const batchId = row.remediationId;
  const auditDetails = { remediationId: row.remediationId, ...(input.rollback ? { rollback: true } : {}) };
  if (plan.kind === 'not_admitted' || plan.kind === 'stale') return { ok: false, error: plan.kind };
  return asActor(async () => {
    // An approval-gated install is never moved forward (it got a change
    // request); on a rollback, an install the rollout moved goes back with it.
    if (plan.install && (input.rollback || !plan.install.gated)) {
      if (inheritedInstall(plan.install, orgId)) return { ok: false, error: 'install_inherited' };
      const moved = await moveInstallPin(plan.install, ref, actor);
      if (moved === 'pending') return { ok: false, error: INSTALL_CHANGE_PENDING };
      if (moved === 'changed') return { ok: false, error: 'install_changed' };
    }
    if (plan.kind === 'step_pin') {
      const outcome = await applyUpgradeToPipeline({
        pipelineId: pipeline.id,
        orgId,
        ...(parentOrgId ? { parentOrgId } : {}),
        actor,
        plan: async (existing) => {
          const fresh = await planMove(existing, rootOrgId, ref, input.rollback ? { pinRanges: true } : {});
          return applyPluginUpgrades(existing.props, fresh.steps);
        },
        redeploy: true,
        batchId,
        auditDetails,
        redeployReason: 'plugin-remediation',
      });
      if (outcome.status === 'failed') return { ok: false, error: outcome.error };
      if (outcome.status === 'unchanged') return { ok: false, error: 'unchanged' };
      const redeploy = outcome.redeploy;
      return redeploy && 'requestId' in redeploy
        ? { ok: true, runRequestId: redeploy.requestId }
        : { ok: true, runRequestId: null, note: REDEPLOY_FAILED };
    }
    // An admitted version (or a moved install): what the config resolves to now, then a redeploy.
    await recordPipelineResolution(pipeline.id, orgId, parentOrgId, pipeline.props);
    const redeploy = await redeployPipeline({ pipelineId: pipeline.id, orgId, ...(parentOrgId ? { parentOrgId } : {}), actor, batchId, reason: 'plugin-remediation', details: auditDetails });
    return 'requestId' in redeploy ? { ok: true, runRequestId: redeploy.requestId } : { ok: true, runRequestId: null, note: REDEPLOY_FAILED };
  });
}

/** The real redeploy retry: the start path alone (the config already moved), as the system principal. */
async function redeployReal(input: Parameters<RolloutDeps['redeploy']>[0]): Promise<MoveResult> {
  const { row, pipeline, rootOrgId } = input;
  const parentOrgId = rootOrgId ?? undefined;
  return runWithTenantContext({ orgId: pipeline.orgId, isSuperAdmin: true, ...(parentOrgId ? { parentOrgId } : {}) }, async () => {
    const redeploy = await redeployPipeline({
      pipelineId: pipeline.id,
      orgId: pipeline.orgId,
      ...(parentOrgId ? { parentOrgId } : {}),
      actor: REMEDIATION_ACTOR,
      batchId: row.remediationId,
      reason: 'plugin-remediation',
      details: { remediationId: row.remediationId, retry: true },
    });
    return 'requestId' in redeploy ? { ok: true, runRequestId: redeploy.requestId } : { ok: true, runRequestId: null, note: REDEPLOY_FAILED };
  });
}

/**
 * Whether a pipeline may go back to `row.fromVersion`: it must still be live,
 * and a KEV-listed Critical finding on it must be covered by the pipeline's
 * active risk acceptance (one that accepted KEV findings).
 */
export async function checkRollbackTarget(row: UpgradeRow, rootOrgId: string | null): Promise<RollbackTargetCheck> {
  let record: Record<string, unknown> | undefined;
  if (row.pluginPublisher === null) {
    const orgs = [...new Set([row.orgId, rootOrgId, SYSTEM_ORG_ID].filter((o): o is string => !!o))];
    const res = await asSystem((tx) => tx.execute(sql`
      SELECT name, version, image_digest, scan_summary, scan_flag, scan_flagged_at FROM plugins
      WHERE name = ${row.pluginName} AND version = ${row.fromVersion} AND deleted_at IS NULL AND yanked_at IS NULL
        AND org_id IN (${sql.join(orgs.map((o) => sql`${o}`), sql`, `)})
      LIMIT 1`));
    record = rowsOf<Record<string, unknown>>(res)[0];
  } else {
    const res = await asSystem((tx) => tx.execute(sql`
      SELECT l.name, v.version, v.image_digest, v.scan_summary, v.scan_flag, v.scan_flagged_at
      FROM plugin_listing_versions v JOIN plugin_listings l ON l.id = v.listing_id JOIN publishers pu ON pu.id = l.publisher_id
      WHERE pu.handle = ${row.pluginPublisher} AND l.name = ${row.pluginName} AND v.version = ${row.fromVersion} AND v.yanked_at IS NULL
      LIMIT 1`));
    record = rowsOf<Record<string, unknown>>(res)[0];
  }
  if (!record) return { ok: false, reason: 'previous_version_deleted' };
  const facts = versionScanFacts({
    name: String(record.name),
    version: String(record.version),
    imageDigest: (record.image_digest as string | null) ?? null,
    scanSummary: record.scan_summary,
    scanFlag: record.scan_flag,
    scanFlaggedAt: toDate(record.scan_flagged_at),
  } as never);
  const kevCritical = facts.findings.filter((f) => f.kev === true && f.severity === 'critical');
  if (kevCritical.length === 0) return { ok: true };
  const acceptances = await runWithTenantContext({ orgId: row.orgId, isSuperAdmin: true }, () => activeAcceptances(row.orgId, row.pipelineId));
  const acceptance = acceptances.byKey.get(acceptanceKey(row.pluginName, row.fromVersion, (record.image_digest as string | null) ?? null));
  const covered = !!acceptance && acceptance.kev && kevCritical.every((f) => acceptance.findingKeys.includes(scanFindingKey(f)));
  return covered ? { ok: true } : { ok: false, reason: 'previous_version_kev' };
}

/** PLUGIN_INTERNAL.reportRemediationRollout, as a system-org service call. */
async function reportReal(remediationId: string, body: { summary: RemediationRolloutSummary; events: RolloutEvent[] }): Promise<'ok' | 'unknown' | 'failed'> {
  const client = new InternalHttpClient(serviceEndpoint('plugin'));
  try {
    const res = await callInternal(client, PLUGIN_INTERNAL.reportRemediationRollout, {
      params: { remediationId },
      body,
      options: { headers: { Authorization: getServiceAuthHeader({ serviceName: serviceIdentity(), orgId: SYSTEM_ORG_ID, role: 'member' }) } },
    });
    if (res.ok) return 'ok';
    if (res.reason === 'status' && res.status === 404) return 'unknown';
    logger.warn('Rollout report refused', { remediationId, reason: res.reason, ...(res.reason === 'status' ? { status: res.status } : {}) });
    return 'failed';
  } catch (err) {
    logger.warn('Rollout report failed', { remediationId, error: errorMessage(err) });
    return 'failed';
  }
}

/** The production dependencies. */
export function realRolloutDeps(): RolloutDeps {
  return {
    now: () => new Date(),
    settings: (orgId, rootOrgId) => readOrgRolloutSettings(orgId, rootOrgId),
    plan: planInScope,
    move: moveReal,
    requestInstallChange,
    redeploy: redeployReal,
    rollbackTarget: checkRollbackTarget,
    report: reportReal,
    ancestors: (orgId) => runnerDeps().hierarchy.ancestors(orgId, undefined, { strict: true }),
    descendants: (orgId) => runnerDeps().hierarchy.descendants(orgId, { strict: true }),
  };
}

let engine: RolloutEngine | null = null;

/** The process's engine (real dependencies). */
export function rolloutEngine(): RolloutEngine {
  engine ??= createRolloutEngine(realRolloutDeps());
  return engine;
}

/** Start the leader-locked rollout worker (one replica per tick). */
export function startRemediationRolloutWorker(): Scheduler {
  const scheduler = createScheduler({
    name: 'remediation-rollout',
    intervalMs: ROLLOUT_TICK_MS,
    startupDelayMs: 15_000,
    lock: { key: leaderLockKey('pipeline', 'remediation-rollout'), ttlMs: 5 * 60_000 },
    // The operator knob off: nothing is moved, rolled back or reported.
    run: async () => { if (remediationEnabled()) await rolloutEngine().tick(); },
  });
  scheduler.start();
  return scheduler;
}
