// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEPLOY_CAPABILITY, type DeletedPipelineDeploymentDto, type RunnerCapability } from '@pipeline-builder/api-core/pipeline-runners';
import { Callout } from '@/components/ui/Callout';
import { stackRemovalNotice } from '@/lib/pipeline-deploys';

/** What the notice knows: a deleted row's `deployment`, or a live pipeline's registration + runner link. */
export type StackNoticeSource =
  | { kind: 'deleted'; deployment: DeletedPipelineDeploymentDto }
  | {
    kind: 'live';
    stackName: string | null;
    region: string | null;
    /** The runner link's runner (null: none linked); `undefined`: the link could not be read. */
    runner: { label: string; capabilities: RunnerCapability[] } | null | undefined;
  }
  | { kind: 'unknown' };

/** Why a purge would leave the stack, or null when nothing in the record stops the runner removing it. */
function retainedReason(
  runner: { capabilities: RunnerCapability[] } | null | undefined,
  stackName: string | null,
  region: string | null,
): 'no_runner' | 'runner_not_deploy_capable' | 'no_stack' | null {
  if (!runner) return 'no_runner';
  if (!runner.capabilities?.includes(DEPLOY_CAPABILITY)) return 'runner_not_deploy_capable';
  if (!stackName || !region) return 'no_stack';
  return null;
}

/**
 * What a delete / purge dialog says about a deployed pipeline's stack — the
 * ONE outcome that will happen. A soft delete never touches the stack; a
 * PURGE asks the pipeline's linked runner to delete it (only a stack tagged
 * for this pipeline) when that runner has deploys enabled; otherwise the stack
 * stays in the AWS account (`cdk destroy` / CloudFormation). Both outcomes
 * are stated only when the deployment genuinely cannot be read.
 */
export function PipelineStackNotice({ purge, source }: { purge: boolean; source: StackNoticeSource }) {
  let text: string;
  if (source.kind === 'deleted') {
    const d = source.deployment;
    text = stackRemovalNotice(purge, {
      stackName: d.stackName,
      region: d.region,
      runnerLabel: d.runner?.label ?? null,
      removedOnPurge: d.stackRemovedOnPurge,
      // The server found no runner able to take the removal now: say why it can't.
      reason: d.stackRemovedOnPurge ? null : retainedReason(d.runner, d.stackName, d.region) ?? 'runner_unavailable',
    });
  } else if (source.kind === 'live' && source.runner !== undefined) {
    // The server's rule (deletedPipelineDeployment): a deploy-capable runner AND a recorded stack name + region.
    const reason = retainedReason(source.runner, source.stackName, source.region);
    text = stackRemovalNotice(purge, {
      stackName: source.stackName, region: source.region, runnerLabel: source.runner?.label ?? null,
      // A runner without deploys is named ("prod cannot remove it …") rather than "Its runner".
      removedOnPurge: reason === null, reason: reason === 'runner_not_deploy_capable' ? null : reason,
    });
  } else {
    text = stackRemovalNotice(purge, 'unknown');
  }
  return (
    <div className="mt-3" data-testid="pipeline-stack-notice">
      <Callout variant="warning">{text}</Callout>
    </div>
  );
}
