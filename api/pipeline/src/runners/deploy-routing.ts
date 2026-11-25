// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which runner deploys a never-deployed pipeline, and queueing the deploy.
 *
 * DEPLOYABLE = the org's eligible runners (its own, and each ancestor's shared
 * with teams — {@link eligibleRunners}) that are active, healthy, not past
 * their upgrade grace, list `deploy:1`, allow the pipeline's name by their
 * prefix allowlist and have a region — and, for an ancestor's runner, whose
 * owner turned on `shareDeploysWithTeams`. Every eligible runner is listed by
 * `GET …/deploy-targets` with its reason when it is not deployable.
 *
 * `POST …/deploys`: no runnerId and one deployable runner → it; several →
 * 409 DEPLOY_RUNNER_REQUIRED (details.runners); none → NO_RUNNER, or
 * RUNNER_DEPLOY_UNSUPPORTED when every runner just lacks `deploy:1`, else
 * RUNNER_NOT_DEPLOYABLE (details.reason). The region is the runner's only one,
 * else the body's (DEPLOY_REGION_NOT_ALLOWED outside the runner's).
 *
 * Picking a runner happens ONLY here, for a pipeline with no registry row. The
 * runner link is written only once the runner's own job deployed it (the
 * proof); from then on the tag rules apply unchanged — nobody re-points a
 * runner by hand.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import {
  DEPLOY_JOB_PROTOCOL_VERSION, DEPLOY_SETUP_COMMAND, pipelineNameMatchesPrefixes, runnerSupportsAction,
  type DeployStartBody, type DeployTargetReason, type DeployTargetRunnerDto, type DeployTargetsDto, type QueuedDeployDto,
} from '@pipeline-builder/api-core/pipeline-runners';
import { newDeployRow } from './deploys.js';
import type { RunnerDeps } from './deps.js';
import { updateGraceExpired } from './lifecycle.js';
import { eligibleRunners, RunnerRouteError, runnersUnavailable, type EligibleRunner } from './routing.js';
import type { RunRequestRow, RunnerRow } from './store.js';
import { RUN_REQUEST_TTL_MS, runnerSettings } from './vocabulary.js';

const logger = createLogger('runner-deploy-routing');

/** What the route resolved about the pipeline before any runner is chosen. */
export interface DeployPipelineFacts {
  pipelineId: string;
  orgId: string;
  parentOrgId?: string;
  /** pipeline-core `deployedPipelineNames` — the single naming source. */
  pipelineName: string;
  stackName: string;
  /** It already has a registry row (deploys through a runner are for a never-deployed pipeline only). */
  registered: boolean;
  /** The pipeline's pinned (or default) managed toolchain release. */
  toolchain: { releaseVersion: string; imageDigest: string | null; deployJobProtocol: number | null };
}

/** Why `runner` cannot deploy a pipeline named `pipelineName` (null: it can). */
export function deployBlocker(deps: RunnerDeps, entry: EligibleRunner, pipelineName: string): DeployTargetReason | null {
  const { runner } = entry;
  if (!runnerSupportsAction(runner.capabilities ?? [], 'deploy')) return 'deploy_not_enabled';
  if (updateGraceExpired(runner, deps.now())) return 'update_required';
  if (runner.health !== 'healthy') return 'unhealthy';
  if (entry.depth > 0 && !runner.shareDeploysWithTeams) return 'team_deploys_not_shared';
  if (!pipelineNameMatchesPrefixes(pipelineName, runner.pipelinePrefixes ?? [])) return 'prefix_mismatch';
  if ((runner.regions ?? []).length === 0) return 'region';
  return null;
}

/** The deploy-targets listing for the pipeline (names of other orgs from the hierarchy client). */
export async function deployTargets(deps: RunnerDeps, facts: Omit<DeployPipelineFacts, 'toolchain'>): Promise<DeployTargetsDto> {
  const base = { pipelineId: facts.pipelineId, alreadyDeployed: facts.registered, setupCommand: DEPLOY_SETUP_COMMAND };
  const avail = await deps.runnersAvailable();
  if (!avail.available) {
    return { ...base, available: false, unavailableReason: avail.reason ?? null, activeRequestId: null, runners: [], autoRunnerId: null };
  }
  const [eligible, active] = await Promise.all([
    eligibleRunners(deps, facts.orgId, facts.parentOrgId),
    deps.store.findActiveDeploy(facts.orgId, facts.pipelineId),
  ]);
  const foreign = [...new Set(eligible.filter((e) => e.depth > 0).map((e) => e.runner.orgId))];
  const names = foreign.length > 0 ? await deps.hierarchy.names(foreign) : {};
  const runners: DeployTargetRunnerDto[] = eligible.map((e) => {
    const reason = deployBlocker(deps, e, facts.pipelineName);
    return {
      id: e.runner.id,
      label: e.runner.label,
      isOwn: e.depth === 0,
      ownerOrgName: e.depth === 0 ? null : (names[e.runner.orgId.toLowerCase()] ?? e.runner.orgId),
      regions: e.runner.regions ?? [],
      deployable: reason === null,
      reason,
    };
  });
  const deployable = runners.filter((r) => r.deployable);
  return {
    ...base,
    available: true,
    unavailableReason: null,
    activeRequestId: active?.id ?? null,
    runners,
    autoRunnerId: deployable.length === 1 ? deployable[0]!.id : null,
  };
}

/** The reused answer for the pipeline's active deploy. */
async function reuseActive(deps: RunnerDeps, active: RunRequestRow): Promise<QueuedDeployDto & { runnerId: string }> {
  const [deploy, runner] = await Promise.all([
    deps.store.getDeploy(active.id),
    active.runnerId ? deps.store.getRunner(active.runnerId) : Promise.resolve(null),
  ]);
  return {
    requestId: active.id,
    status: active.status === 'delivering' || active.status === 'deploying' ? active.status : 'queued',
    runnerLabel: runner?.label ?? '',
    region: deploy?.region ?? '',
    reused: true,
    runnerId: active.runnerId ?? '',
  };
}

/** A Postgres unique violation (drizzle wraps the driver error as `cause`). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

const unsupported = (label: string) => new RunnerRouteError('RUNNER_DEPLOY_UNSUPPORTED',
  `Pipeline runner "${label}" can't deploy pipelines yet: update it with ${DEPLOY_SETUP_COMMAND}.`, { runnerLabel: label });

const REASON_TEXT: Record<DeployTargetReason, string> = {
  deploy_not_enabled: `deploys are not enabled on it (${DEPLOY_SETUP_COMMAND})`,
  update_required: 'it runs an unsupported version (re-run pipeline-manager infra setup-runner)',
  unhealthy: 'it is unreachable',
  prefix_mismatch: "its stack's pipeline-name allowlist does not cover this pipeline",
  team_deploys_not_shared: 'its owner has not shared deploys with teams',
  region: 'it has no allowed region',
};

/** Pick the runner (and region) for a deploy, or refuse. */
async function chooseRunner(deps: RunnerDeps, facts: DeployPipelineFacts, body: DeployStartBody): Promise<{ runner: RunnerRow; region: string }> {
  const eligible = await eligibleRunners(deps, facts.orgId, facts.parentOrgId);
  if (eligible.length === 0) {
    throw new RunnerRouteError('NO_RUNNER', `Deploying needs a pipeline runner in the target AWS account, set up with ${DEPLOY_SETUP_COMMAND}.`);
  }
  const judged = eligible.map((e) => ({ entry: e, reason: deployBlocker(deps, e, facts.pipelineName) }));
  let chosen: RunnerRow;
  if (body.runnerId) {
    const hit = judged.find((j) => j.entry.runner.id.toLowerCase() === body.runnerId!.toLowerCase());
    if (!hit) throw new RunnerRouteError('RUNNER_NOT_DEPLOYABLE', 'That runner is not one this pipeline can be deployed through.');
    if (hit.reason === 'deploy_not_enabled') throw unsupported(hit.entry.runner.label);
    if (hit.reason) {
      throw new RunnerRouteError('RUNNER_NOT_DEPLOYABLE', `Pipeline runner "${hit.entry.runner.label}" can't deploy this pipeline: ${REASON_TEXT[hit.reason]}.`, { runnerLabel: hit.entry.runner.label, reason: hit.reason });
    }
    chosen = hit.entry.runner;
  } else {
    const deployable = judged.filter((j) => j.reason === null).map((j) => j.entry.runner);
    if (deployable.length > 1) {
      throw new RunnerRouteError('DEPLOY_RUNNER_REQUIRED', 'Several pipeline runners can deploy this pipeline: choose one.', {
        runners: deployable.map((r) => ({ id: r.id, label: r.label, regions: r.regions ?? [] })),
      });
    }
    if (deployable.length === 0) {
      if (judged.every((j) => j.reason === 'deploy_not_enabled')) throw unsupported(judged[0]!.entry.runner.label);
      const first = judged.find((j) => j.reason !== 'deploy_not_enabled') ?? judged[0]!;
      throw new RunnerRouteError('RUNNER_NOT_DEPLOYABLE', `No pipeline runner can deploy this pipeline: "${first.entry.runner.label}" — ${REASON_TEXT[first.reason!]}.`, {
        runnerLabel: first.entry.runner.label, reason: first.reason!,
      });
    }
    chosen = deployable[0]!;
  }
  const regions = chosen.regions ?? [];
  const region = body.region ?? (regions.length === 1 ? regions[0]! : undefined);
  if (!region || !regions.includes(region)) {
    throw new RunnerRouteError('DEPLOY_REGION_NOT_ALLOWED', body.region
      ? `Pipeline runner "${chosen.label}" deploys only to ${regions.join(', ')}.`
      : `Pipeline runner "${chosen.label}" allows several regions: choose one (${regions.join(', ')}).`, { runnerLabel: chosen.label, regions });
  }
  return { runner: chosen, region };
}

/**
 * Queue the deploy of a never-deployed pipeline (`POST …/deploys`, after the
 * route's gates and compliance re-check). Returns the pipeline's active deploy
 * when one is running on the same runner (or no runner was named).
 */
export async function startDeploy(deps: RunnerDeps, facts: DeployPipelineFacts, body: DeployStartBody, userId: string): Promise<QueuedDeployDto & { runnerId: string }> {
  const avail = await deps.runnersAvailable();
  if (!avail.available) throw runnersUnavailable(avail.reason ?? 'paused');
  if (facts.registered) {
    throw new RunnerRouteError('ALREADY_DEPLOYED', 'This pipeline is already deployed (it has a registration); deploys through a runner are for a pipeline that was never deployed.');
  }
  const inProgress = (active: RunRequestRow) => new RunnerRouteError('DEPLOY_IN_PROGRESS', 'This pipeline is already being deployed through another runner.', { requestId: active.id });
  const active = await deps.store.findActiveDeploy(facts.orgId, facts.pipelineId);
  if (active) {
    if (!body.runnerId || active.runnerId?.toLowerCase() === body.runnerId.toLowerCase()) return reuseActive(deps, active);
    throw inProgress(active);
  }
  const { toolchain } = facts;
  if (toolchain.deployJobProtocol !== DEPLOY_JOB_PROTOCOL_VERSION || !toolchain.imageDigest) {
    throw new RunnerRouteError('TOOLCHAIN_TOO_OLD_FOR_DEPLOY',
      `Toolchain release ${toolchain.releaseVersion} can't deploy through a runner (its cdk-synth image ships deploy-job protocol ${toolchain.deployJobProtocol ?? 'none'}; this platform needs ${DEPLOY_JOB_PROTOCOL_VERSION}). `
      + 'Pin a newer toolchain release in the pipeline\'s toolchain.release (or follow your organization\'s default), then deploy again.',
      { toolchainRelease: toolchain.releaseVersion, deployJobProtocol: toolchain.deployJobProtocol });
  }
  const { runner, region } = await chooseRunner(deps, facts, body);

  const { deployRequestsPerHour, maxActiveDeploysPerRunner } = runnerSettings();
  if (!(await deps.limiter.hit(`deploy:${facts.orgId.toLowerCase()}`, deployRequestsPerHour, 3_600_000, { failClosed: true }))) {
    throw new RunnerRouteError('DEPLOY_RATE_LIMITED', `Your organization can deploy at most ${deployRequestsPerHour} pipelines per hour through runners; try again later.`, { runnerLabel: runner.label });
  }
  if ((await deps.store.countActiveDeploys(runner.id)) >= maxActiveDeploysPerRunner) {
    throw new RunnerRouteError('TOO_MANY_DEPLOYS', `Pipeline runner "${runner.label}" is already running ${maxActiveDeploysPerRunner} deploys; wait for one to finish.`, { runnerLabel: runner.label });
  }

  const deployRow = await newDeployRow(deps, facts.orgId, facts.pipelineId, {
    region, pipelineName: facts.pipelineName, stackName: facts.stackName, imageDigest: toolchain.imageDigest, toolchainRelease: toolchain.releaseVersion,
  });
  let request: RunRequestRow;
  try {
    request = (await deps.store.insertDeploy({
      id: deps.newId(),
      orgId: facts.orgId,
      pipelineId: facts.pipelineId,
      action: 'deploy',
      requestedBy: userId,
      requestedAt: new Date(deps.now()),
      expiresAt: new Date(deps.now() + RUN_REQUEST_TTL_MS),
      status: 'queued',
      runnerId: runner.id,
    }, deployRow)).request;
  } catch (err) {
    // The one-active-deploy index: a concurrent Deploy inserted first.
    if (!isUniqueViolation(err)) throw err;
    const winner = await deps.store.findActiveDeploy(facts.orgId, facts.pipelineId);
    if (!winner) throw err;
    if (winner.runnerId === runner.id) return reuseActive(deps, winner);
    throw inProgress(winner);
  }
  deps.metrics.inc('pipeline_runner_requests_total', { status: 'queued' });
  await deps.queue.enqueue(request.id).catch((err: unknown) => {
    logger.warn('Deploy enqueue failed; the sweep re-kicks the request', { requestId: request.id, error: errorMessage(err) });
  });
  return { requestId: request.id, status: 'queued', runnerLabel: runner.label, region, reused: false, runnerId: runner.id };
}
