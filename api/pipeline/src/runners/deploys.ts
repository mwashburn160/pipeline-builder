// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A deploy (or undeploy) through a runner, after it is queued.
 *
 *  delivery   the dispatcher signs a `deploy` / `undeploy` request carrying the
 *             {@link RunDeployClaim} (with the single-use grant, re-signed from
 *             its encrypted copy on a redelivery) — only to a runner whose last
 *             pong listed `deploy:1` (an older bundle would answer 401
 *             SIGNATURE_INVALID and page RunnerSignatureInvalid);
 *  accept     the runner answers `deploying` / `undeploying {buildId}`: the
 *             request leaves the 10-minute delivery lifetime and gets a
 *             deadline (RUNNER_DEPLOY_DEADLINE_MINUTES) and a poll schedule;
 *  progress   the job's own session posts (stage, result) show progress sooner;
 *  final      the leader's sweep ({@link pollDeploys}) sends a signed
 *             `deploy_status` every RUNNER_DEPLOY_STATUS_POLL_SECONDS and the
 *             build's state decides: succeeded → deployed (the registry row is
 *             ensured and linked to the runner — the `deployed` fallback of the
 *             job's own registry post); failed / stopped / timed out → failed
 *             (or cancelled). Past the deadline: `deploy_cancel` and
 *             DEPLOY_TIMED_OUT.
 *
 * Every terminal status wipes the grant's encrypted copy and the session,
 * counts `pipeline_runner_deploys_total{outcome}` (+ the failure class), and
 * is audited `pipeline.deploy.complete` / `pipeline.undeploy.complete` by the
 * system actor. Nothing here logs or audits a grant, a session token, an AWS
 * account id or a build log.
 */

import { createLogger, errorMessage, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import {
  DEPLOY_GRANT_PREFIX, DEPLOY_JOB_IMAGE_REPOSITORY, DEPLOY_JOB_PROTOCOL_VERSION, DEPLOY_RESULT_OK, deployFailureOf, deployGrantTtlMs, deployLogHint,
  IN_PROGRESS_RUN_REQUEST_STATUSES, isTerminalRunRequestStatus, RUNNER_DEPLOY_METRICS, runnerSupportsAction,
  type DeployErrorCode, type DeployRequestDto, type DeployRequestStatus, type DeployStage, type RunDeployClaim, type TerminalRunRequestStatus,
} from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush, type ReplyVerdict } from './delivery.js';
import { hashDeployToken, loadDeploy, mintDeployToken } from './deploy-grants.js';
import type { RunnerDeps } from './deps.js';
import { finishRequest } from './lifecycle.js';
import { RunnerRouteError } from './routing.js';
import type { DeployRequestPair, RunnerDeployInsert, RunnerDeployRow, RunRequestRow, RunnerRow } from './store.js';
import { isSystemRequester, PENDING_STATUSES, runnerSettings, RUN_REQUEST_TTL_MS, SYSTEM_DEPLOY_STATUS, SYSTEM_UNDEPLOY } from './vocabulary.js';

const logger = createLogger('runner-deploys');

/** Whether a request row is a deploy or an undeploy. */
export function isDeployAction(action: string): action is 'deploy' | 'undeploy' {
  return action === 'deploy' || action === 'undeploy';
}

/** The statuses a finished deploy / undeploy can move from (its delivery, or its running build). */
export const DEPLOY_FINISHABLE_STATUSES = [...PENDING_STATUSES, ...IN_PROGRESS_RUN_REQUEST_STATUSES];

// -- The deploy half of a new request --------------------------------------------

/** What a new deploy / undeploy runs: the job's target and image. */
export interface DeployTarget {
  region: string;
  pipelineName: string;
  stackName: string;
  imageDigest: string;
  toolchainRelease: string;
}

/**
 * The deploy row of a request about to be queued, with a freshly minted
 * grant: only its sha256 and its org-encrypted copy are stored.
 */
export async function newDeployRow(deps: RunnerDeps, orgId: string, pipelineId: string, target: DeployTarget): Promise<Omit<RunnerDeployInsert, 'requestId'>> {
  const grant = mintDeployToken(DEPLOY_GRANT_PREFIX);
  return {
    orgId,
    pipelineId,
    ...target,
    stage: 'queued',
    grantHash: hashDeployToken(grant),
    grantEnc: await deps.secrets.encrypt(grant, orgId),
    grantExpiresAt: new Date(deps.now() + deployGrantTtlMs()),
  };
}

// -- Delivery ----------------------------------------------------------------------

/**
 * The claim block of a deploy / undeploy delivery. The grant is decrypted from
 * its stored copy; once the job has exchanged it (the copy is wiped) a
 * redelivery carries a fresh grant that was never stored — the runner answers
 * it with the build already running for this request id, and a new build
 * would be refused at its exchange.
 */
export async function deployClaimFor(deps: RunnerDeps, request: RunRequestRow, deploy: RunnerDeployRow): Promise<RunDeployClaim> {
  const grant = deploy.grantEnc ? await deps.secrets.decrypt(deploy.grantEnc, request.orgId) : mintDeployToken(DEPLOY_GRANT_PREFIX);
  return {
    grant,
    protocol: DEPLOY_JOB_PROTOCOL_VERSION,
    mode: request.action === 'undeploy' ? 'undeploy' : 'deploy',
    region: deploy.region,
    pipelineName: deploy.pipelineName,
    stackName: deploy.stackName,
    image: { repository: DEPLOY_JOB_IMAGE_REPOSITORY, digest: deploy.imageDigest },
    toolchainRelease: deploy.toolchainRelease,
  };
}

/**
 * The runner accepted (`deploying` / `undeploying {buildId}`): the request is
 * running. Its deadline and poll schedule start now, and the grant's life is
 * re-based on the build's start (the queue + provisioning margin). A request a
 * person cancelled while this delivery was in flight gets the build stopped.
 */
export async function acceptDeploy(deps: RunnerDeps, request: RunRequestRow, runner: RunnerRow, verdict: Extract<ReplyVerdict, { kind: 'success' }>): Promise<void> {
  const now = deps.now();
  const status = request.action === 'undeploy' ? 'undeploying' : 'deploying';
  const accepted = await deps.store.updateRequest(request.id, { status, acceptedAt: new Date(now), nextAttemptAt: null, lastDeliveryError: null }, PENDING_STATUSES);
  if (!accepted) {
    // Cancelled (or expired) while the delivery was in flight: the build the
    // runner just started must not run on unwatched.
    if (verdict.buildId) await sendCancel(deps, request, runner, verdict.buildId);
    return;
  }
  const deploy = await deps.store.getDeploy(request.id);
  const { deployDeadlineMs, deployStatusPollMs } = runnerSettings();
  await deps.store.updateDeploy(request.id, {
    buildId: verdict.buildId ?? null,
    deadlineAt: new Date(now + deployDeadlineMs),
    nextPollAt: new Date(now + deployStatusPollMs),
    ...(deploy && !deploy.grantUsedAt ? { grantExpiresAt: new Date(now + deployGrantTtlMs()) } : {}),
    ...(deploy?.stage === 'queued' ? { stage: 'starting' as const } : {}),
  }, { onlyIfUnfinished: true });
  deps.metrics.inc('pipeline_runner_requests_total', { status });
}

/**
 * A runner's refusal of a deploy delivery that needs more than failing it:
 *  - DEPLOY_NOT_ENABLED — the stack has no deploy project: its stored
 *    capabilities are cleared (nothing gated is signed for it again until a
 *    pong lists `deploy:1`);
 *  - PIPELINE_ALREADY_DEPLOYED — a pipeline tagged with this id is already in
 *    the account: the platform registers it (no link: unproven) and links it
 *    through the background probe, as any registration.
 */
export async function onDeployRefused(deps: RunnerDeps, request: RunRequestRow, runner: RunnerRow, code: string): Promise<void> {
  if (code === 'DEPLOY_NOT_ENABLED') {
    await deps.store.updateRunner(runner.id, { capabilities: [] }).catch(() => null);
    return;
  }
  if (code === 'PIPELINE_ALREADY_DEPLOYED' && request.action === 'deploy') {
    const deploy = await deps.store.getDeploy(request.id);
    if (!deploy) return;
    try {
      await deps.registry.registerDeployment({
        pipelineId: request.pipelineId, orgId: request.orgId, pipelineName: deploy.pipelineName, stackName: deploy.stackName, region: deploy.region,
      });
      const { linkInBackground } = await import('./routing.js');
      void linkInBackground(deps, { pipelineId: request.pipelineId, orgId: request.orgId, requestedBy: request.requestedBy });
    } catch (err) {
      logger.warn('Registering an already-deployed pipeline failed', { requestId: request.id, error: errorMessage(err) });
    }
  }
}

// -- Terminal bookkeeping ----------------------------------------------------------

/**
 * After a deploy / undeploy reached a terminal status (finishRequest moved it):
 * close its deploy half (finished, grant copy and session wiped, result
 * recorded), count it, audit it, and for a `deployed` one ensure the registry
 * row linked to the runner whose job deployed it — the job's own registry post
 * normally did that already; the upsert is idempotent.
 */
export async function onDeployFinished(deps: RunnerDeps, row: RunRequestRow, status: TerminalRunRequestStatus, errorCode: string | undefined): Promise<void> {
  const now = deps.now();
  const succeeded = status === 'deployed' || status === 'undeployed';
  const deploy = await deps.store.updateDeploy(row.id, {
    finishedAt: new Date(now),
    grantEnc: null,
    sessionHash: null,
    nextPollAt: null,
    resultCode: succeeded ? DEPLOY_RESULT_OK : (errorCode ?? null),
    ...(succeeded ? { stage: 'done' as const } : {}),
  }, { onlyIfUnfinished: true }).catch((err: unknown) => {
    logger.warn('Closing a finished deploy failed', { requestId: row.id, error: errorMessage(err) });
    return null;
  });
  const failure = succeeded ? null : deployFailureOf(errorCode ?? (status === 'cancelled' ? 'DEPLOY_CANCELLED' : null));
  deps.metrics.inc(RUNNER_DEPLOY_METRICS.deploys, { outcome: status });
  if (failure) deps.metrics.inc(RUNNER_DEPLOY_METRICS.failuresByClass, { class: failure.failureClass });
  const durationMs = row.acceptedAt ? Math.max(0, now - row.acceptedAt.getTime()) : null;
  if (durationMs !== null) deps.metrics.observe?.(RUNNER_DEPLOY_METRICS.duration, { action: row.action }, durationMs / 1000);

  let linked = false;
  if (status === 'deployed' && deploy && row.runnerId) {
    try {
      linked = (await deps.registry.registerDeployment({
        pipelineId: row.pipelineId, orgId: row.orgId, pipelineName: deploy.pipelineName, stackName: deploy.stackName, region: deploy.region, runnerId: row.runnerId,
      })).linked;
    } catch (err) {
      logger.warn('Registering a deployed pipeline failed', { requestId: row.id, error: errorMessage(err) });
    }
  }
  deps.audit({
    action: row.action === 'undeploy' ? 'pipeline.undeploy.complete' : 'pipeline.deploy.complete',
    actorId: SYSTEM_ACTOR_ID,
    orgId: row.orgId,
    targetType: 'pipeline',
    targetId: row.pipelineId,
    ...(succeeded ? {} : { outcome: 'failure' as const }),
    details: {
      outcome: status,
      pipelineId: row.pipelineId,
      requestId: row.id,
      runnerId: row.runnerId,
      region: deploy?.region ?? null,
      stage: deploy?.stage ?? null,
      errorCode: errorCode ?? null,
      class: failure?.failureClass ?? null,
      durationMs,
      linked,
    },
  });
}

// -- The sweep's poll --------------------------------------------------------------

/** A signed read or cancel of a deploy's build (never a request row of its own). */
async function sendDeployRead(deps: RunnerDeps, request: RunRequestRow, runner: RunnerRow, action: 'deploy_status' | 'deploy_cancel', buildId: string): Promise<ReplyVerdict | null> {
  // Never sign a gated action for a runner whose bundle does not speak it.
  if (!runnerSupportsAction(runner.capabilities ?? [], action) || runner.status !== 'active' || !runner.functionUrl) return null;
  return deliverPush(deps, runner, {
    runnerId: runner.id,
    requestId: deps.newId(),
    action,
    pipelineId: request.pipelineId,
    deployRequestId: request.id,
    buildId,
    requestedBy: SYSTEM_DEPLOY_STATUS,
  });
}

/** Best-effort StopBuild through the runner. */
async function sendCancel(deps: RunnerDeps, request: RunRequestRow, runner: RunnerRow, buildId: string): Promise<boolean> {
  try {
    const verdict = await sendDeployRead(deps, request, runner, 'deploy_cancel', buildId);
    return verdict?.kind === 'success';
  } catch (err) {
    logger.warn('Deploy cancel not delivered', { requestId: request.id, error: errorMessage(err) });
    return false;
  }
}

export interface DeployPollCounts {
  polled: number;
  finished: number;
  timedOut: number;
}

/**
 * The leader's deploy step: every running deploy / undeploy whose poll is due
 * is read with a signed `deploy_status`; past its deadline it is cancelled and
 * fails DEPLOY_TIMED_OUT. Then the overdue gauge (running past the deadline —
 * RunnerDeployStuck) is published.
 */
export async function pollDeploys(deps: RunnerDeps, now: number): Promise<DeployPollCounts> {
  const counts: DeployPollCounts = { polled: 0, finished: 0, timedOut: 0 };
  const { deployStatusPollMs } = runnerSettings();
  for (const { request, deploy } of await deps.store.listDeploysDue(new Date(now), 200)) {
    try {
      const runner = request.runnerId ? await deps.store.getRunner(request.runnerId) : null;
      if (!runner || runner.status === 'revoked') {
        if (await finishRequest(deps, request, 'expired', { errorCode: 'RUNNER_REVOKED' })) counts.finished++;
        continue;
      }
      if (deploy.deadlineAt && deploy.deadlineAt.getTime() <= now) {
        if (deploy.buildId && runner.health === 'healthy') await sendCancel(deps, request, runner, deploy.buildId);
        if (await finishRequest(deps, request, 'failed', { errorCode: 'DEPLOY_TIMED_OUT' })) { counts.finished++; counts.timedOut++; }
        continue;
      }
      const next = { nextPollAt: new Date(now + deployStatusPollMs) };
      // An unreachable runner is not asked (its health pings decide); a deploy
      // without a build id cannot be (the deadline still applies above).
      if (runner.health !== 'healthy' || !deploy.buildId) {
        await deps.store.updateDeploy(request.id, next, { onlyIfUnfinished: true });
        continue;
      }
      counts.polled++;
      const verdict = await sendDeployRead(deps, request, runner, 'deploy_status', deploy.buildId);
      if (verdict?.kind === 'fail' && verdict.code === 'DEPLOY_BUILD_NOT_FOUND') {
        if (await finishRequest(deps, request, 'failed', { errorCode: 'DEPLOY_BUILD_NOT_FOUND' })) counts.finished++;
        continue;
      }
      if (verdict?.kind !== 'success' || !verdict.buildState) {
        await deps.store.updateDeploy(request.id, next, { onlyIfUnfinished: true });
        continue;
      }
      const final = finalStatusOf(request, deploy, verdict);
      if (final) {
        if (verdict.stage) await deps.store.updateDeploy(request.id, { stage: verdict.stage }, { onlyIfUnfinished: true });
        if (await finishRequest(deps, request, final.status, final.errorCode ? { errorCode: final.errorCode } : {})) counts.finished++;
        continue;
      }
      // Still running. A person's cancel that did not reach the runner is sent again.
      if (deploy.cancelRequestedAt) await sendCancel(deps, request, runner, deploy.buildId);
      await deps.store.updateDeploy(request.id, { ...next, ...(verdict.stage ? { stage: verdict.stage } : {}) }, { onlyIfUnfinished: true });
    } catch (err) {
      logger.warn('Deploy poll failed', { requestId: request.id, error: errorMessage(err) });
    }
  }
  deps.metrics.gauge(RUNNER_DEPLOY_METRICS.overdue, {}, await deps.store.countOverdueDeploys(new Date(now)));
  return counts;
}

/**
 * The terminal status a build state means, or null while it runs. A stopped
 * build a person cancelled is `cancelled`; any other failure carries the job's
 * result code, else DEPLOY_JOB_ERROR (CodeBuild's own timeout: DEPLOY_TIMED_OUT).
 */
export function finalStatusOf(
  request: Pick<RunRequestRow, 'action'>, deploy: Pick<RunnerDeployRow, 'cancelRequestedAt' | 'resultCode'>, v: Extract<ReplyVerdict, { kind: 'success' }>,
): { status: TerminalRunRequestStatus; errorCode?: DeployErrorCode } | null {
  const reported = v.resultCode ?? (deploy.resultCode as DeployErrorCode | null) ?? null;
  const failedCode = (reported && reported !== DEPLOY_RESULT_OK ? reported : null) as DeployErrorCode | null;
  switch (v.buildState) {
    case 'in_progress':
      return null;
    case 'succeeded':
      return failedCode ? { status: 'failed', errorCode: failedCode } : { status: request.action === 'undeploy' ? 'undeployed' : 'deployed' };
    case 'stopped':
      return deploy.cancelRequestedAt ? { status: 'cancelled', errorCode: 'DEPLOY_CANCELLED' } : { status: 'failed', errorCode: failedCode ?? 'DEPLOY_JOB_ERROR' };
    case 'timed_out':
      return { status: 'failed', errorCode: 'DEPLOY_TIMED_OUT' };
    default:
      return { status: 'failed', errorCode: failedCode ?? 'DEPLOY_JOB_ERROR' };
  }
}

// -- Cancel ------------------------------------------------------------------------

/**
 * A person cancels a deploy. Not yet delivered (queued / delivering): it is
 * cancelled at once (a delivery already in flight gets its build stopped when
 * it answers). Running: the cancel is recorded and a signed `deploy_cancel`
 * (StopBuild) sent now — and again on every poll until the build stops; the
 * poll records `cancelled`. Finished: 409 DEPLOY_NOT_CANCELLABLE.
 */
export async function cancelDeploy(deps: RunnerDeps, orgId: string, pipelineId: string, requestId: string, userId: string): Promise<DeployRequestPair> {
  const pair = await loadDeploy(deps, requestId);
  if (!pair || pair.request.action !== 'deploy' || pair.request.orgId !== orgId || pair.request.pipelineId.toLowerCase() !== pipelineId.toLowerCase()) {
    throw new RunnerRouteError('NOT_FOUND', 'Deploy not found.');
  }
  const notCancellable = () => new RunnerRouteError('DEPLOY_NOT_CANCELLABLE', 'This deploy already finished.');
  if (isTerminalRunRequestStatus(pair.request.status)) throw notCancellable();
  const now = new Date(deps.now());
  await deps.store.updateDeploy(requestId, { cancelRequestedAt: now, cancelledBy: userId }, { onlyIfUnfinished: true });
  if ((PENDING_STATUSES as readonly string[]).includes(pair.request.status)) {
    const done = await finishRequest(deps, pair.request, 'cancelled', { errorCode: 'DEPLOY_CANCELLED' });
    if (!done) {
      // Accepted between the read and the write: cancel it as a running one.
      const fresh = await loadDeploy(deps, requestId);
      if (!fresh || isTerminalRunRequestStatus(fresh.request.status)) throw notCancellable();
      return cancelRunning(deps, fresh);
    }
    return (await loadDeploy(deps, requestId)) ?? pair;
  }
  return cancelRunning(deps, pair);
}

async function cancelRunning(deps: RunnerDeps, pair: DeployRequestPair): Promise<DeployRequestPair> {
  const runner = pair.request.runnerId ? await deps.store.getRunner(pair.request.runnerId) : null;
  if (runner && pair.deploy.buildId && runner.health === 'healthy') await sendCancel(deps, pair.request, runner, pair.deploy.buildId);
  // Poll soon: the stopped build is what records `cancelled`.
  await deps.store.updateDeploy(pair.request.id, { nextPollAt: new Date(deps.now()) }, { onlyIfUnfinished: true });
  return (await loadDeploy(deps, pair.request.id)) ?? pair;
}

// -- The job's progress posts ------------------------------------------------------

/** `POST …/progress {stage}`: the job's stage, shown before the next poll. */
export async function recordDeployProgress(deps: RunnerDeps, pair: DeployRequestPair, stage: DeployStage): Promise<void> {
  await deps.store.updateDeploy(pair.request.id, { stage }, { onlyIfUnfinished: true });
}

/**
 * `POST …/result {code, stage?}`: the job's result, recorded and shown at
 * once; the poll (moved up to now) decides the final status from the build.
 */
export async function recordDeployResult(deps: RunnerDeps, pair: DeployRequestPair, code: string, stage?: DeployStage): Promise<void> {
  await deps.store.updateDeploy(pair.request.id, { resultCode: code, nextPollAt: new Date(deps.now()), ...(stage ? { stage } : {}) }, { onlyIfUnfinished: true });
}

// -- Reading -----------------------------------------------------------------------

/** The DTO of one deploy request. */
export function deployDto(request: RunRequestRow, deploy: RunnerDeployRow, runner: Pick<RunnerRow, 'id' | 'label'> | null): DeployRequestDto {
  const status = request.status as DeployRequestStatus;
  const failed = status === 'failed' || status === 'expired' || status === 'cancelled';
  const errorCode = failed ? ((request.errorCode ?? (status === 'cancelled' ? 'DEPLOY_CANCELLED' : null)) as DeployErrorCode | null) : null;
  const failure = failed ? deployFailureOf(errorCode) : null;
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    requestId: request.id,
    pipelineId: request.pipelineId,
    status,
    stage: deploy.stage,
    runnerId: request.runnerId ?? '',
    runnerLabel: runner?.label ?? '',
    region: deploy.region,
    errorCode,
    failureClass: failure?.failureClass ?? null,
    retryable: failure?.retryable ?? false,
    requestedAt: iso(request.requestedAt) ?? new Date(0).toISOString(),
    acceptedAt: iso(request.acceptedAt),
    finishedAt: iso(deploy.finishedAt),
    deadlineAt: iso(deploy.deadlineAt),
    logHint: request.runnerId && deploy.buildId ? deployLogHint(request.runnerId, deploy.buildId) : null,
  };
}

/** One of the org's deploys of `pipelineId` as a DTO, or null (another org's is indistinguishable from none). */
export async function readDeploy(deps: RunnerDeps, orgId: string, pipelineId: string, requestId: string | 'latest'): Promise<DeployRequestDto | null> {
  const request = requestId === 'latest' ? await deps.store.latestDeploy(orgId, pipelineId) : (/^[0-9a-f-]{36}$/i.test(requestId) ? await deps.store.getRequest(requestId) : null);
  if (!request || request.action !== 'deploy' || request.orgId !== orgId || request.pipelineId.toLowerCase() !== pipelineId.toLowerCase()) return null;
  const deploy = await deps.store.getDeploy(request.id);
  if (!deploy) return null;
  const runner = request.runnerId ? await deps.store.getRunner(request.runnerId) : null;
  return deployDto(request, deploy, runner);
}

// -- Undeploy on purge (change 5) --------------------------------------------------

/** What a purge knows about the pipeline's deployment before the row goes. */
export interface UndeployInput {
  orgId: string;
  pipelineId: string;
  runnerId: string;
  region: string;
  pipelineName: string;
  stackName: string;
}

/**
 * The runner a purged pipeline's stack can be removed through: its registry
 * row's linked runner, when that runner is active and lists `deploy:1`
 * (undeploy is covered by the same capability). Null otherwise — the stack
 * stays in the account and the purge warns so.
 */
export async function undeployRunnerFor(deps: RunnerDeps, runnerId: string | null | undefined): Promise<RunnerRow | null> {
  if (!runnerId) return null;
  const runner = await deps.store.getRunner(runnerId);
  if (!runner || runner.status !== 'active' || !runnerSupportsAction(runner.capabilities ?? [], 'undeploy')) return null;
  return runner;
}

/**
 * Queue the `undeploy` of a purged pipeline (system-initiated: no rate limit,
 * no step-up). The job deletes the stack only when it is tagged for THIS
 * pipeline; the outcome is audited `pipeline.undeploy.complete`. The image is
 * the release the platform default resolves to for the org (the stack's own
 * pipeline config is gone).
 */
export async function queueUndeploy(deps: RunnerDeps, input: UndeployInput, image: { digest: string; toolchainRelease: string }): Promise<string> {
  const deploy = await newDeployRow(deps, input.orgId, input.pipelineId, {
    region: input.region, pipelineName: input.pipelineName, stackName: input.stackName, imageDigest: image.digest, toolchainRelease: image.toolchainRelease,
  });
  const { request } = await deps.store.insertDeploy({
    id: deps.newId(),
    orgId: input.orgId,
    pipelineId: input.pipelineId,
    action: 'undeploy',
    requestedBy: SYSTEM_UNDEPLOY,
    requestedAt: new Date(deps.now()),
    expiresAt: new Date(deps.now() + RUN_REQUEST_TTL_MS),
    status: 'queued',
    runnerId: input.runnerId,
  }, deploy);
  deps.metrics.inc('pipeline_runner_requests_total', { status: 'queued' });
  await deps.queue.enqueue(request.id).catch((err: unknown) => {
    logger.warn('Undeploy enqueue failed; the sweep re-kicks it', { requestId: request.id, error: errorMessage(err) });
  });
  return request.id;
}

/** Whether a request is system-initiated (an undeploy on purge). */
export function isSystemDeploy(request: Pick<RunRequestRow, 'requestedBy'>): boolean {
  return isSystemRequester(request.requestedBy);
}
