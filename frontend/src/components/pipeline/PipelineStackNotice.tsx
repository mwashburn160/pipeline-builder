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
    const capable = !!d.runner?.capabilities.includes(DEPLOY_CAPABILITY);
    text = stackRemovalNotice(purge, {
      stackName: d.stackName,
      region: d.region,
      runnerLabel: d.runner?.label ?? null,
      removedOnPurge: d.stackRemovedOnPurge,
      reason: d.stackRemovedOnPurge ? null
        : !d.runner ? 'no_runner'
          : !capable ? 'runner_not_deploy_capable'
            : !d.stackName || !d.region ? 'no_stack' : 'runner_unavailable',
    });
  } else if (source.kind === 'live' && source.runner !== undefined) {
    const r = source.runner;
    const capable = !!r?.capabilities?.includes(DEPLOY_CAPABILITY);
    text = stackRemovalNotice(purge, {
      stackName: source.stackName, region: source.region, runnerLabel: r?.label ?? null,
      removedOnPurge: capable, reason: r ? null : 'no_runner',
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
