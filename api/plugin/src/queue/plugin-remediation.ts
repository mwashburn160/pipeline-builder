// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `plugin-remediation` queue job (docs/plugin-publishing.md "Scan gates").
 *
 * Queued by the nightly rescan at the end of a completed pass
 * (services/remediation/queueing.ts) on the org's plugin build TIER queue with a
 * BullMQ priority, so it runs on the same workers as builds and always AFTER
 * un-prioritised user builds. On top of the worker's own gates it holds:
 *  - a fleet-wide remediation slot: at most PLUGIN_REMEDIATION_CONCURRENCY at
 *    once (the shared-base pass has its own PLUGIN_REMEDIATION_BASE_CONCURRENCY);
 *  - the org's normal build slot (the `flexible` class, so remediation never
 *    eats the org's standard headroom) and the replica build budget per build.
 * Without a slot it is delayed (no attempt spent) and tried again.
 *
 * It spends no build credits (build-credits.ts) and reserves no `plugins` quota
 * slot (build-quota.ts): remediation versions don't count toward the plugin quota.
 *
 * The row in `plugin_remediations` is the source of truth; the job re-reads it
 * and acts only while it is still active. One run:
 *   queued → rebuild → libraries → (engine) →
 *     nothing fixable  → needs_owner (N39)
 *     propose          → awaiting_approval (N36 awaiting; N39 for the rest)
 *     apply            → published → rolling_out (N36; N39 for the rest)
 * An APPROVED remediation (awaiting_approval + decided) re-runs the engine and
 * publishes its verified result. A `kind = 'toolchain'` row (a managed
 * toolchain release) runs services/remediation/toolchain.ts instead: it only
 * ever records a release candidate — the job never publishes one; a system-org
 * admin approves it through routes/toolchain-fixes.ts. A canary fixture runs as a dry run (never
 * published). Errors: a fail-closed engine error (SOURCE_CHECKSUM_MISMATCH)
 * fails it at once; anything else is retried by BullMQ and fails it
 * (`error`, a short code) on the last attempt.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import {
  ACTIVE_BUILD_REMEDIATION_STAGES,
  createLogger,
  createQuotaService,
  getServiceAuthHeader,
  PLUGIN_REMEDIATION_JOB_NAME,
  pluginRemediationJobId,
  type QuotaService,
  errorMessage,
  nextRemediationVersion,
  remediationArtifactPrefix,
  remediationDiffKey,
  remediationPatchedSourceKey,
  remediationPublishMode,
  type PluginRemediationJobData,
  type RemediationVersionBump,
  type PluginSmokeTest,
} from '@pipeline-builder/api-core';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';
import { DelayedError, type Job, type Queue } from 'bullmq';

import { getHealthRedisConnection, getOrgTier, getTierQueue } from './connections.js';
import { remediationConfig } from '../config.js';
import { putRemediationArtifact } from '../services/plugin-sources.js';
import { recordCanaryOutcome, isCanaryPlugin } from '../services/remediation/canary.js';
import { keepLease, release, tryAcquire, type SemaphoreRedis } from '../services/remediation/concurrency.js';
import { runRemediationEngine, type EngineOutcome } from '../services/remediation/engine.js';
import { countStage, sendOwnerRequest } from '../services/remediation/lifecycle.js';
import type { RemediationPorts } from '../services/remediation/ports.js';
import { publishCandidate, recordFromRow, RemediationPublishAbort, smokeCommand } from '../services/remediation/publish.js';
import { getRemediation, newestCleanOwnerVersion, pluginRow, readSettings, takenVersions, updateRemediation } from '../services/remediation/store.js';
import type { ToolchainInputsStore } from '../services/remediation/toolchain-inputs.js';
import type { ToolchainPorts } from '../services/remediation/toolchain.js';
import { sendRemediationNotice } from '../services/remediation-notices.js';

const logger = createLogger('plugin-remediation');

/** How long a job without a remediation slot waits before trying again. */
export const REMEDIATION_SLOT_RETRY_MS = 60_000;

export interface RemediationJobDeps {
  ports?: RemediationPorts;
  redis?: SemaphoreRedis;
  /** Run `fn` holding the org's build slot (production: slot-manager + replica gate); false = no slot now. */
  withOrgSlot?: <T>(fn: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;
  /** A toolchain row's ports (the engine's plus image labels) and kept build inputs. */
  toolchainPorts?: ToolchainPorts;
  toolchainInputs?: ToolchainInputsStore;
}

let livePorts: RemediationPorts | null = null;
async function defaultPorts(): Promise<RemediationPorts> {
  if (!livePorts) livePorts = (await import('../services/remediation/tooling.js')).liveRemediationPorts();
  return livePorts;
}

type JobResult = 'skipped' | 'delayed' | PluginRemediation['stage'];

/** The worker entry point for a `plugin-remediation` job. */
export async function processRemediationJob(job: Job<PluginRemediationJobData>, token: string | undefined, deps: RemediationJobDeps = {}): Promise<JobResult> {
  const cfg = remediationConfig();
  if (!cfg.enabled) return 'skipped';
  const row = await getRemediation(job.data.remediationId);
  if (!row || !(ACTIVE_BUILD_REMEDIATION_STAGES as readonly string[]).includes(row.stage)) return 'skipped';
  if (row.stage === 'awaiting_approval' && !row.decidedAt) return 'skipped';

  const redis = deps.redis ?? (getHealthRedisConnection() as unknown as SemaphoreRedis);
  if (!await tryAcquire(redis, 'tenant', row.id, cfg.concurrency)) {
    await job.moveToDelayed(Date.now() + REMEDIATION_SLOT_RETRY_MS, token);
    throw new DelayedError();
  }
  const stop = keepLease(redis, 'tenant', row.id);
  try {
    const run = () => runRemediation(row, deps, { lastAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) });
    if (!deps.withOrgSlot) return await run();
    const r = await deps.withOrgSlot(run);
    if (r.ran) return r.value;
  } finally {
    stop();
    await release(redis, 'tenant', row.id).catch(() => undefined);
  }
  await job.moveToDelayed(Date.now() + REMEDIATION_SLOT_RETRY_MS, token);
  throw new DelayedError();
}

async function fail(row: PluginRemediation, code: string, outcome: 'error' | 'cancelled' = 'error'): Promise<'failed'> {
  await updateRemediation(row.id, { stage: 'failed', outcome, error: code.slice(0, 64), finishedAt: new Date() }, ACTIVE_BUILD_REMEDIATION_STAGES);
  countStage('failed', outcome);
  return 'failed';
}

/** A toolchain release candidate run: never publishes (approval is a route). */
async function runToolchain(row: PluginRemediation, deps: RemediationJobDeps, opts: { lastAttempt: boolean }): Promise<JobResult> {
  if (row.stage === 'awaiting_approval') return 'skipped';
  const { runToolchainRemediation } = await import('../services/remediation/toolchain.js');
  const ports = deps.toolchainPorts ?? (await import('../services/remediation/tooling.js')).liveToolchainPorts();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-toolchain-fix-'));
  try {
    return await runToolchainRemediation(row, { ports, workRoot, ...(deps.toolchainInputs ? { inputs: deps.toolchainInputs } : {}) });
  } catch (err) {
    logger.warn('Toolchain remediation run failed', { remediationId: row.id, error: errorMessage(err) });
    if (opts.lastAttempt) return await fail(row, (err as { code?: string }).code ?? 'JOB_ERROR');
    throw err;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

/** One remediation run (exported for tests). */
export async function runRemediation(row: PluginRemediation, deps: RemediationJobDeps, opts: { lastAttempt: boolean } = { lastAttempt: true }): Promise<JobResult> {
  if (row.kind === 'toolchain') return runToolchain(row, deps, opts);
  const approved = row.stage === 'awaiting_approval' && !!row.decidedAt;
  const from = await pluginRow(row.pluginId);
  if (!from || from.deletedAt) return fail(row, 'VERSION_DELETED', 'cancelled');
  const settings = await readSettings(row.orgId);
  if (settings.mode === 'off' && !approved) return fail(row, 'MODE_OFF', 'cancelled');

  // The owner's own clean upload wins.
  if (await newestCleanOwnerVersion(row.orgId, row.pluginName, row.fromVersion)) {
    await updateRemediation(row.id, { stage: 'done', outcome: 'superseded', finishedAt: new Date() }, ACTIVE_BUILD_REMEDIATION_STAGES);
    countStage('done', 'superseded');
    return 'done';
  }

  const taken = await takenVersions(row.orgId, row.pluginName);
  const versionFor = (bump: RemediationVersionBump): string => {
    const v = nextRemediationVersion(from.version, taken, bump);
    if (!v) throw Object.assign(new Error('version is not semver'), { code: 'VERSION_NOT_SEMVER' });
    return v;
  };
  try { versionFor('patch'); } catch { return fail(row, 'VERSION_NOT_SEMVER'); }

  if (!approved) await updateRemediation(row.id, { stage: 'rebuild', startedAt: new Date() }, ['queued', 'rebuild', 'libraries']);
  const ports = deps.ports ?? await defaultPorts();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-remediation-'));
  let outcome: EngineOutcome;
  try {
    outcome = await runRemediationEngine({
      remediationId: row.id,
      orgId: row.orgId,
      plugin: {
        id: from.id,
        name: from.name,
        version: from.version,
        imageDigest: from.imageDigest ?? null,
        sourceKind: from.sourceKind,
        sourceKey: from.sourceKey ?? null,
        sourceSha256: from.sourceSha256 ?? null,
        smokeTest: smokeCommand(from.smokeTest as PluginSmokeTest | null) || null,
        originalFindings: from.scanSummary?.findings ?? [],
        record: recordFromRow(from),
      },
      targeted: row.targeted ?? [],
      settings,
      versionFor,
      onStage: async (stage) => { if (!approved) await updateRemediation(row.id, { stage }, ['rebuild', 'libraries']); },
      workRoot,
    }, ports);
  } catch (err) {
    logger.warn('Remediation run failed', { remediationId: row.id, error: errorMessage(err) });
    if (opts.lastAttempt) return await fail(row, (err as { code?: string }).code ?? 'JOB_ERROR');
    throw err;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
  if (outcome.error) return fail(row, outcome.error);

  const base = {
    cleared: outcome.cleared,
    remaining: outcome.remaining,
    fixMethods: outcome.fixMethods,
    versionBump: outcome.candidate ? outcome.versionBump : null,
    upgradeLevel: outcome.upgradeLevel,
  };
  const current = (await updateRemediation(row.id, base, ACTIVE_BUILD_REMEDIATION_STAGES));
  if (!current) {
    if (outcome.candidate) await ports.discardImage(outcome.candidate.ref).catch(() => undefined);
    return 'skipped'; // cancelled while it ran
  }

  // A canary is a dry run: verified, never published.
  if (isCanaryPlugin(row.orgId, row.pluginName)) {
    if (outcome.candidate) await ports.discardImage(outcome.candidate.ref).catch(() => undefined);
    const stage = outcome.candidate ? 'done' : 'needs_owner';
    const result = outcome.candidate ? (outcome.remaining.length ? 'partial' : 'cleared') : 'owner_request';
    await updateRemediation(row.id, { stage, outcome: result, finishedAt: new Date() });
    countStage(stage, result);
    await recordCanaryOutcome(row.pluginName, result === 'cleared');
    return stage;
  }

  if (!outcome.candidate) {
    const done = (await updateRemediation(row.id, { stage: 'needs_owner', outcome: 'owner_request', finishedAt: new Date() }, ACTIVE_BUILD_REMEDIATION_STAGES)) ?? current;
    countStage('needs_owner', 'owner_request');
    await sendOwnerRequest(done, outcome.remaining, from.createdBy ?? null);
    return 'needs_owner';
  }

  // The patch and the patched context are kept with the remediation (a reviewer reads the diff).
  const c = outcome.candidate;
  let patchKey: string | null = null;
  try {
    await putRemediationArtifact(remediationPatchedSourceKey(row.orgId, row.pluginId, row.fromVersion, row.id, c.patched.sha256), c.patched.zip);
    if (c.diff) {
      patchKey = remediationDiffKey(row.orgId, row.pluginId, row.fromVersion, row.id);
      await putRemediationArtifact(patchKey, c.diff);
    }
  } catch (err) {
    logger.warn('Remediation artifacts not stored', { remediationId: row.id, prefix: remediationArtifactPrefix(row.orgId, row.pluginId, row.fromVersion, row.id), error: errorMessage(err) });
  }

  const decision = remediationPublishMode(approved ? 'apply' : settings.mode, {
    majorUpgrade: !approved && outcome.majorUpgrade,
    hasSmokeTest: approved || outcome.hasSmokeTest,
    askAgentPatch: !approved && outcome.askAgentPatch,
  });
  // `approved` stands in for the org mode only: the reasons a person approved stay on the row.
  const proposeReasons = approved ? row.proposeReasons : decision.proposeReasons;
  await updateRemediation(row.id, { patchKey, proposeReasons, publishMode: approved ? 'propose' : (decision.mode === 'apply' ? 'apply' : 'propose') });

  if (decision.mode !== 'apply') {
    // Propose: nothing is published without a plugins:write approval with step-up.
    // The candidate image goes; approval re-runs and publishes a freshly verified build.
    await ports.discardImage(c.ref).catch(() => undefined);
    const waiting = (await updateRemediation(row.id, { stage: 'awaiting_approval', decidedAt: null, decidedBy: null }, ACTIVE_BUILD_REMEDIATION_STAGES)) ?? current;
    countStage('awaiting_approval', null);
    await sendRemediationNotice({
      code: 'N36',
      orgId: row.orgId,
      remediationId: row.id,
      pluginName: row.pluginName,
      fromVersion: row.fromVersion,
      toVersion: c.version,
      awaitingApproval: true,
      cleared: outcome.cleared,
      remaining: outcome.remaining,
      proposeReasons,
      uploaderId: from.createdBy ?? null,
    }).catch(() => undefined);
    if (outcome.remaining.length > 0) await sendOwnerRequest(waiting, outcome.remaining, from.createdBy ?? null);
    return 'awaiting_approval';
  }

  try {
    const published = await publishCandidate({ row: { ...current, ...base }, from, candidate: c, uploaderId: from.createdBy ?? null });
    if (outcome.remaining.length > 0) await sendOwnerRequest(published, outcome.remaining, from.createdBy ?? null);
    return published.stage;
  } catch (err) {
    await ports.discardImage(c.ref).catch(() => undefined);
    if (err instanceof RemediationPublishAbort) return 'skipped';
    logger.warn('Remediation publish failed', { remediationId: row.id, error: errorMessage(err) });
    return fail(row, (err as { code?: string }).code ?? 'PUBLISH_FAILED');
  }
}

let quota: QuotaService | null = null;

/**
 * Add a remediation job to its org's tier queue (idempotent per job id).
 * `suffix` distinguishes the approved-publish run of the same remediation.
 */
export async function enqueueRemediationJob(
  orgId: string,
  data: PluginRemediationJobData,
  opts: { jobId: string; priority: number },
  quotaService?: QuotaService,
): Promise<void> {
  quota ??= quotaService ?? createQuotaService();
  const tier = await getOrgTier(quota, orgId, getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }));
  await (getTierQueue(tier) as unknown as Queue<PluginRemediationJobData>).add(PLUGIN_REMEDIATION_JOB_NAME, data, {
    jobId: opts.jobId, priority: opts.priority, attempts: 2,
  });
}

/** Queue the approved-publish run of a remediation. */
export async function enqueueApprovedRun(row: PluginRemediation): Promise<void> {
  await enqueueRemediationJob(row.orgId, {
    kind: 'plugin-remediation', remediationId: row.id, orgId: row.orgId, pluginId: row.pluginId, pluginName: row.pluginName, fromVersion: row.fromVersion,
  }, { jobId: `${pluginRemediationJobId(row.id)}-approved`, priority: 1 });
}
