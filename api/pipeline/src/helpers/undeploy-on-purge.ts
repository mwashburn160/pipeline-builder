// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Removing a purged pipeline's stack through its runner (`undeploy`).
 *
 * A PURGE (hard delete — never a soft delete) of a pipeline whose registry row
 * is linked to an active runner listing `deploy:1` sends that runner a signed
 * `undeploy`: its CodeBuild project deletes the pipeline's stack, and only
 * when the stack is tagged `pb.pipeline-id` = this pipeline. The outcome is
 * audited `pipeline.undeploy.complete`. Otherwise the stack stays in the
 * account (the purge still needs `?force=true`, and says why): remove it with
 * `cdk destroy` or CloudFormation.
 */

import { DEPLOY_JOB_PROTOCOL_VERSION, type StackRetainedReason } from '@pipeline-builder/api-core/pipeline-runners';
import { resolveManagedToolchain } from '@pipeline-builder/pipeline-data';
import { queueUndeploy, undeployRunnerFor, type UndeployInput } from '../runners/deploys.js';
import type { RunnerDeps } from '../runners/deps.js';

/** What a purge knows about a pipeline's deployment (pipeline-registry-service `deploymentOf`). */
export interface PurgeDeployment {
  registryId: string;
  stackName: string | null;
  region: string | null;
  pipelineName?: string | null;
  runnerId?: string | null;
}

/** Why a purge leaves the stack in the account. */
export type { StackRetainedReason } from '@pipeline-builder/api-core/pipeline-runners';

export type UndeployPlan =
  | { kind: 'undeploy'; runnerId: string; runnerLabel: string; input: UndeployInput; image: { digest: string; toolchainRelease: string } }
  | { kind: 'retained'; reason: StackRetainedReason };

/** The toolchain the undeploy job runs (the org's resolution for the pipeline's pin). */
export type ToolchainResolver = (orgId: string, releasePin: string | undefined) => Promise<{ releaseVersion: string; imageDigest: string | null; deployJobProtocol: number | null }>;

const resolveToolchain: ToolchainResolver = async (orgId, releasePin) => {
  const r = await resolveManagedToolchain({ orgId }, releasePin ? { releasePin } : {});
  return { releaseVersion: r.releaseVersion, imageDigest: r.synth.imageDigest ?? null, deployJobProtocol: r.deployJobProtocol };
};

/** Whether (and through which runner) the purge of `pipelineId` can remove its stack. Decided BEFORE the purge. */
export async function planUndeploy(
  deps: RunnerDeps,
  orgId: string,
  pipelineId: string,
  releasePin: string | undefined,
  deployment: PurgeDeployment,
  resolve: ToolchainResolver = resolveToolchain,
): Promise<UndeployPlan> {
  if (!deployment.runnerId) return { kind: 'retained', reason: 'no_runner' };
  if (!deployment.stackName || !deployment.region || !deployment.pipelineName) return { kind: 'retained', reason: 'no_stack' };
  const runner = await undeployRunnerFor(deps, deployment.runnerId);
  if (!runner) return { kind: 'retained', reason: 'runner_not_deploy_capable' };
  let toolchain: Awaited<ReturnType<ToolchainResolver>>;
  try {
    toolchain = await resolve(orgId, releasePin);
  } catch {
    // A pin to a deleted release: the org's default still runs the job.
    try { toolchain = await resolve(orgId, undefined); } catch { return { kind: 'retained', reason: 'toolchain_too_old' }; }
  }
  if (toolchain.deployJobProtocol !== DEPLOY_JOB_PROTOCOL_VERSION || !toolchain.imageDigest) return { kind: 'retained', reason: 'toolchain_too_old' };
  return {
    kind: 'undeploy',
    runnerId: runner.id,
    runnerLabel: runner.label,
    input: { orgId, pipelineId, runnerId: runner.id, region: deployment.region, pipelineName: deployment.pipelineName, stackName: deployment.stackName },
    image: { digest: toolchain.imageDigest, toolchainRelease: toolchain.releaseVersion },
  };
}

/** Queue the planned undeploy (after the purge landed). Returns its request id. */
export function startUndeploy(deps: RunnerDeps, plan: Extract<UndeployPlan, { kind: 'undeploy' }>): Promise<string> {
  return queueUndeploy(deps, plan.input, plan.image);
}
