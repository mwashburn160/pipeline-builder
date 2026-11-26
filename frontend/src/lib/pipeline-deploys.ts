// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deploying a never-deployed pipeline through a pipeline runner — the copy
 * every deploy surface shares (the create flow's next step, the pipeline
 * page's banner, the delete / purge dialogs).
 *
 * Every Record below is keyed by an api-core catalog type, so a code, class,
 * stage, status or reason added there fails to compile until it has copy here.
 * Free of React and of the api client.
 */

import {
  ACTIVE_DEPLOY_STATUSES, DEPLOY_SETUP_COMMAND, DEPLOY_STAGES, isRunnerDeployErrorCode, isRunnerErrorCode,
  type ActiveDeployStatus, type DeployFailureClass, type DeployLogHint, type DeployRequestStatus, type DeployStage,
  type DeployTargetReason, type RunnerDeployErrorCode,
  type StackRetainedReason,
} from '@pipeline-builder/api-core/pipeline-runners';
import { runnerErrorCopy, type RunnerErrorLink } from '@/lib/pipeline-runners';

export { DEPLOY_SETUP_COMMAND };

/** The command that bootstraps CDK in a region (the deploy job never bootstraps). */
export const BOOTSTRAP_COMMAND = 'pipeline-manager infra bootstrap --region <region>';

/** The command that stores the registry pull credential the runner's deploy project reads. */
export const REGISTRY_TOKEN_COMMAND = 'pipeline-manager infra store-token --scope registry:push --region <stack-region>';

export interface DeployFailureCopy {
  /** The headline (bold). */
  title: string;
  /** What happened. */
  body: string;
  /** What to do, in order. */
  nextSteps: string[];
  /** A link to the runners panel where that is the fix. */
  link: RunnerErrorLink;
}

/** Copy per deploy RESULT code (the job's and the platform's own). */
export const DEPLOY_ERROR_COPY = {
  DEPLOY_GRANT_REJECTED: {
    title: 'The deploy job\'s one-time credential was refused.',
    body: 'The job presented a grant that was already used, unknown, or for a deploy no longer running. Platform operators are alerted when a grant is reused.',
    nextSteps: ['Start the deploy again: a new deploy gets a new grant.', 'If it happens again, tell your platform operator — a reused grant can mean someone replayed the job\'s credential.'],
    link: null,
  },
  DEPLOY_GRANT_EXPIRED: {
    title: 'The deploy job started too late to use its credential.',
    body: 'Its build waited in the runner\'s CodeBuild queue longer than the grant lives (the queue timeout plus a margin), so nothing was deployed.',
    nextSteps: ['Retry the deploy.', 'If builds queue for long in that account, wait for them to finish or raise the runner\'s DeployConcurrency.'],
    link: 'runners',
  },
  PIPELINE_FETCH_FAILED: {
    title: 'The deploy job could not read this pipeline from the platform.',
    body: 'The build reached the platform but its read of the pipeline failed. Nothing was deployed.',
    nextSteps: ['Retry the deploy.', 'If it keeps failing, check that the runner\'s account can reach the platform\'s URL.'],
    link: null,
  },
  PLUGIN_RESOLUTION_FAILED: {
    title: 'A plugin this pipeline uses could not be resolved.',
    body: 'The deploy job looked up each of the pipeline\'s plugins and one is not available to this organization (removed, renamed, or not shared with it).',
    nextSteps: ['Edit the pipeline to use an available plugin version, then deploy again.'],
    link: null,
  },
  DEPLOY_TARGET_MISMATCH: {
    title: 'The synthesized pipeline is not the one this deploy named.',
    body: 'Its pipeline name, stack name or region differs from the deploy request, so the job refused to deploy it.',
    nextSteps: ['Check the pipeline\'s name and region settings, then deploy again.'],
    link: null,
  },
  STACK_OWNED_BY_OTHER_PIPELINE: {
    title: 'A stack with this pipeline\'s name already belongs to something else.',
    body: 'The runner\'s account has a CloudFormation stack of that name tagged for another pipeline (or not tagged at all). The job never deletes or overwrites it.',
    nextSteps: ['Rename this pipeline, or remove the other stack in CloudFormation if it is no longer used, then deploy again.'],
    link: null,
  },
  CDK_NOT_BOOTSTRAPPED: {
    title: 'The target region has no CDK bootstrap.',
    body: 'Deploys run through the account\'s CDK bootstrap roles, and that region has none. The deploy job never bootstraps an account itself.',
    nextSteps: [`Run ${BOOTSTRAP_COMMAND} (add --qualifier <q> if the account uses a non-default qualifier) with credentials for the runner's AWS account, or re-run setup-runner with --bootstrap, then retry.`],
    link: null,
  },
  CDK_BOOTSTRAP_OUTDATED: {
    title: 'The target region\'s CDK bootstrap is too old for this pipeline.',
    body: 'The bootstrap in that region is older than CDK bootstrap version 21, which deploys through a runner need.',
    nextSteps: [`Run ${BOOTSTRAP_COMMAND} again (add --qualifier <q> if the account uses a non-default qualifier) to update it, then retry.`],
    link: null,
  },
  ACCOUNT_SECRETS_MISSING: {
    title: 'Secrets this pipeline needs are not in the runner\'s AWS account.',
    body: 'The pipeline reads secrets under pipeline-builder/ in Secrets Manager, and at least one is missing in the target region.',
    nextSteps: ['Store the missing secrets with pipeline-manager infra store-token (or in Secrets Manager), then retry.'],
    link: null,
  },
  DEPLOY_PERMISSION_DENIED: {
    title: 'AWS refused an action the deploy needed.',
    body: 'A CDK bootstrap role (or the runner\'s permissions boundary) did not allow a call the deploy made. The bootstrap execution policy is what limits a deploy.',
    nextSteps: ['Read the build\'s log for the refused action, widen the bootstrap execution policy or the boundary if the pipeline really needs it, then retry.'],
    link: null,
  },
  CFN_DEPLOY_FAILED: {
    title: 'CloudFormation could not deploy the pipeline\'s stack.',
    body: 'The deploy reached CloudFormation and a resource failed. A failed first deploy is cleaned up automatically on the next attempt.',
    nextSteps: ['Open the stack\'s events in CloudFormation (or the build\'s log) for the failed resource, fix the cause, then retry.'],
    link: null,
  },
  STACK_DELETE_FAILED: {
    title: 'This pipeline\'s old stack could not be deleted.',
    body: 'Before deploying again the job deletes a stack left by a failed first deploy, and that delete did not complete.',
    nextSteps: ['Open the stack in CloudFormation, resolve what blocks its deletion (a retained resource, a non-empty bucket), then retry.'],
    link: null,
  },
  DEPLOY_IMAGE_PULL_FAILED: {
    title: 'The runner\'s deploy project could not pull the deploy image.',
    body: 'CodeBuild could not pull the pipeline\'s cdk-synth image from the platform registry.',
    nextSteps: [`Store the registry credential with ${REGISTRY_TOKEN_COMMAND} in the runner's account and region, then retry.`],
    link: 'runners',
  },
  DEPLOY_JOB_PROTOCOL_MISMATCH: {
    title: 'The deploy image speaks a different deploy protocol than the platform.',
    body: 'The pipeline\'s toolchain release ships a deploy job the platform cannot drive.',
    nextSteps: ['Upgrade the pipeline\'s toolchain to the current release, then deploy again.'],
    link: null,
  },
  DEPLOY_NEEDS_PRIVILEGED: {
    title: 'This pipeline\'s stack carries a Docker image asset, which a runner cannot deploy.',
    body: 'The runner\'s deploy build runs unprivileged (no Docker daemon). Pipelines built by Pipeline Builder never contain Docker image assets, so the job checked the synthesized assembly and stopped before deploying anything.',
    nextSteps: ['Deploy this pipeline with pipeline-manager pipeline deploy --id <pipelineId> from a machine with Docker and AWS credentials for the account.'],
    link: null,
  },
  DEPLOY_TIMED_OUT: {
    title: 'The deploy did not finish in time.',
    body: 'It ran past its deadline (or CodeBuild\'s own timeout), so the platform stopped it.',
    nextSteps: ['Check the build\'s log for where it stalled, then retry. A long deploy may need a higher DeployTimeoutMinutes on the runner.'],
    link: null,
  },
  DEPLOY_CANCELLED: {
    title: 'The deploy was cancelled.',
    body: 'Someone cancelled it before it finished. A stack a cancelled first deploy left behind is cleaned up on the next attempt.',
    nextSteps: ['Deploy again when you are ready.'],
    link: null,
  },
  DEPLOY_JOB_ERROR: {
    title: 'The deploy job failed.',
    body: 'Something inside the job failed that it could not classify.',
    nextSteps: ['Read the build\'s log in the runner\'s AWS account, then retry.'],
    link: null,
  },
} satisfies Record<RunnerDeployErrorCode, DeployFailureCopy>;

/** A short name and the general next step per failure class (the fallback, and the step under a runner code). */
export const DEPLOY_FAILURE_CLASS_COPY: Readonly<Record<DeployFailureClass, { label: string; nextStep: string }>> = {
  account_setup: { label: 'Runner account setup', nextStep: 'Fix the setup in the runner\'s AWS account, then retry.' },
  definition: { label: 'Pipeline definition', nextStep: 'Edit the pipeline to fix its definition, then deploy again.' },
  aws_permission: { label: 'AWS permissions', nextStep: 'Check the CDK bootstrap roles and the runner\'s permissions boundary, then retry.' },
  cloudformation: { label: 'CloudFormation', nextStep: 'Open the stack\'s events in CloudFormation for the failed resource, then retry.' },
  image: { label: 'Deploy image', nextStep: 'Check the runner\'s deploy project can pull the platform\'s cdk-synth image, then retry.' },
  platform: { label: 'Platform', nextStep: 'Retry the deploy; if it keeps failing, tell your platform operator.' },
  timeout: { label: 'Timed out', nextStep: 'Check the build\'s log for where it stalled, then retry.' },
  cancelled: { label: 'Cancelled', nextStep: 'Deploy again when you are ready.' },
  unknown: { label: 'Unknown', nextStep: 'Read the build\'s log in the runner\'s AWS account, then retry.' },
};

/** What each stage of the deploy job reads as. */
export const DEPLOY_STAGE_LABEL: Readonly<Record<DeployStage, string>> = {
  queued: 'Queued',
  starting: 'Starting the build',
  authenticating: 'Authenticating',
  fetching: 'Fetching the pipeline',
  prechecking: 'Checking the account',
  cleaning: 'Removing a failed earlier attempt',
  synthesizing: 'Synthesizing',
  deploying: 'Deploying',
  registering: 'Registering',
  removing: 'Removing the stack',
  done: 'Done',
};

/** What each deploy request status reads as. */
export const DEPLOY_STATUS_LABEL: Readonly<Record<DeployRequestStatus, string>> = {
  queued: 'Queued for the runner',
  delivering: 'Delivering to the runner',
  deploying: 'Deploying',
  deployed: 'Deployed',
  failed: 'Failed',
  expired: 'Not delivered',
  cancelled: 'Cancelled',
};

/** Why an eligible runner cannot deploy this pipeline. */
export const DEPLOY_TARGET_REASON_COPY: Readonly<Record<DeployTargetReason, string>> = {
  deploy_not_enabled: `Deploys are not enabled on it — update it with ${DEPLOY_SETUP_COMMAND}`,
  update_required: 'It needs an update — re-run pipeline-manager infra setup-runner',
  unhealthy: 'It is not answering the platform',
  prefix_mismatch: 'Its pipeline prefix allowlist does not cover this pipeline\'s name',
  team_deploys_not_shared: 'Its owner has not let teams deploy through it',
  region: 'None of its allowed regions can be used for this pipeline',
};

const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_DEPLOY_STATUSES);

/** queued | delivering | deploying: the pipeline's active deploy (Cancel is offered). */
export function isActiveDeployStatus(s: string): s is ActiveDeployStatus {
  return ACTIVE.has(s);
}

/** Whether `s` is a status nothing further happens after. */
export function isFinishedDeployStatus(s: string): boolean {
  return s === 'deployed' || s === 'failed' || s === 'expired' || s === 'cancelled';
}

/**
 * The copy for a failed / expired / cancelled deploy: its result code's own;
 * a runner catalog code (a refusal, not delivered) reads the runner banner's
 * copy with the class's next step; no code reads the class alone.
 */
export function deployFailureCopy(code: string | null | undefined, failureClass: DeployFailureClass | null | undefined): DeployFailureCopy {
  if (isRunnerDeployErrorCode(code)) return DEPLOY_ERROR_COPY[code];
  const cls = failureClass ? DEPLOY_FAILURE_CLASS_COPY[failureClass] : null;
  if (code && (isRunnerErrorCode(code) || code === 'RUN_REQUEST_EXPIRED')) {
    const c = code === 'RUN_REQUEST_EXPIRED'
      ? { title: 'The deploy was not delivered to the pipeline runner within 10 minutes, so it expired.', body: 'Nothing was deployed. The runner may be down or unreachable.', link: 'runners' as const }
      : runnerErrorCopy(code);
    return { title: c.title, body: c.body, nextSteps: [cls?.nextStep ?? 'Fix it, then retry.'], link: c.link };
  }
  if (code) {
    return { title: 'The deploy failed.', body: `It ended with ${code}.`, nextSteps: [cls?.nextStep ?? DEPLOY_FAILURE_CLASS_COPY.unknown.nextStep], link: null };
  }
  return {
    title: cls ? `The deploy failed (${cls.label.toLowerCase()}).` : 'The deploy failed.',
    body: 'It gave no reason.',
    nextSteps: [cls?.nextStep ?? DEPLOY_FAILURE_CLASS_COPY.unknown.nextStep],
    link: null,
  };
}

export type DeployStepState = 'done' | 'current' | 'pending' | 'failed';

/** The deploy stages shown as steps (`removing` is an undeploy's; `cleaning` only when the job used it). */
const DEPLOY_STEP_STAGES: readonly DeployStage[] = DEPLOY_STAGES.filter((s) => s !== 'removing');

/** Each step of a deploy with its state, from the stage it is (or ended) in and its status. */
export function deployStageSteps(stage: DeployStage, status: DeployRequestStatus): Array<{ stage: DeployStage; label: string; state: DeployStepState }> {
  const stages = DEPLOY_STEP_STAGES.filter((s) => s !== 'cleaning' || stage === 'cleaning');
  const finished = status === 'deployed';
  const at = finished ? stages.length : Math.max(0, stages.indexOf(stage));
  const ended = status === 'failed' || status === 'expired' || status === 'cancelled';
  return stages.map((s, i) => ({
    stage: s,
    label: DEPLOY_STAGE_LABEL[s],
    state: i < at ? 'done' : i === at ? (ended ? 'failed' : 'current') : 'pending',
  }));
}

/** "prod (us-east-1)", plus ", shared by Acme" for a parent's runner. */
export function deployTargetLabel(r: { label: string; isOwn: boolean; ownerOrgName: string | null }, region: string): string {
  const base = `${r.label} (${region})`;
  return !r.isOwn && r.ownerOrgName ? `${base}, shared by ${r.ownerOrgName}` : base;
}

/** Where a failed deploy's build logs are: in the RUNNER's account, never shown here. */
export function logHintGuidance(hint: DeployLogHint): string {
  return `Open CloudWatch in the runner's AWS account: log group ${hint.logGroup}${hint.buildId ? `, build ${hint.buildId}` : ''} (CodeBuild project ${hint.project}).`;
}

/** Why a purge leaves a pipeline's stack in the account (the purge's `stackRetained.reason`, a refusal's `details.stackRetainedReason`). */
export type { StackRetainedReason };

/** The server's reasons, plus `runner_unavailable` (the UI's: a deploy-enabled runner that is not active right now). */
export const STACK_RETAINED_REASON_COPY: Readonly<Record<StackRetainedReason | 'runner_unavailable', string>> = {
  no_runner: 'No pipeline runner is linked to it',
  runner_unavailable: 'Its runner cannot take the removal right now (it is not active)',
  runner_not_deploy_capable: 'Its runner cannot remove it (deploys are not enabled on it)',
  toolchain_too_old: 'Its toolchain is too old for the runner\'s undeploy job',
  no_stack: 'The platform has no stack name and region recorded for it',
  undeploy_not_queued: 'Its runner was due to delete it, but that removal could not be queued when the pipeline was purged',
};

const REMOVE_IT = 'remove it with cdk destroy or in the CloudFormation console';

function stackName(d: { stackName: string | null; region: string | null }): string {
  return d.stackName ? `${d.stackName}${d.region ? ` (${d.region})` : ''}` : 'its stack';
}

function reasonText(reason: string | null | undefined): string | null {
  return reason && Object.hasOwn(STACK_RETAINED_REASON_COPY, reason) ? STACK_RETAINED_REASON_COPY[reason as keyof typeof STACK_RETAINED_REASON_COPY] : null;
}

/**
 * What the stack of a deployed pipeline will be when it is deleted / purged —
 * the ONE true outcome. `stack`:
 *  - `{ removedOnPurge: true, runnerLabel }` — a purge asks that runner to delete it;
 *  - `{ removedOnPurge: false, … }` — it stays in the account (`reason` says why);
 *  - `'unknown'` — the deployment could not be read: both outcomes are stated.
 * A soft delete never touches the stack; it says what a later purge will do.
 */
export function stackRemovalNotice(purge: boolean, stack: 'unknown' | {
  stackName: string | null;
  region: string | null;
  runnerLabel: string | null;
  removedOnPurge: boolean;
  reason?: StackRetainedReason | string | null;
}): string {
  const lead = purge ? '' : 'Deleting keeps the deployed stack running. ';
  if (stack === 'unknown') {
    return purge
      ? `If this pipeline is deployed and its runner has deploys enabled, purging asks that runner to delete the stack (only a stack tagged for this pipeline); otherwise the stack stays in your AWS account — ${REMOVE_IT}.`
      : `${lead}If its runner has deploys enabled, purging it from Recently deleted asks that runner to delete the stack (only a stack tagged for this pipeline); otherwise the stack stays in your AWS account — ${REMOVE_IT}.`;
  }
  const name = stackName(stack);
  if (stack.removedOnPurge && stack.runnerLabel) {
    const target = name === 'its stack' ? 'the stack' : `the stack ${name}`;
    return `${lead}${purge ? 'Purging asks' : 'Purging it from Recently deleted asks'} ${stack.runnerLabel} to delete ${target} (only a stack tagged for this pipeline).`;
  }
  const why = reasonText(stack.reason)
    ?? (stack.runnerLabel ? `${stack.runnerLabel} cannot remove it (deploys are not enabled on it)` : STACK_RETAINED_REASON_COPY.no_runner);
  return `${lead}${why}, so ${name === 'its stack' ? 'the stack' : name} stays in your AWS account${purge ? '' : ' after a purge'} — ${REMOVE_IT}.`;
}

/** What a finished purge did to the stack (its `undeploy` / `stackRetained`), or null when nothing was deployed. */
export function purgeResultCopy(result: {
  undeploy?: { requestId: string; runnerLabel: string } | null;
  stackRetained?: { stackName: string | null; region: string | null; reason: string } | null;
} | null | undefined): { tone: 'info' | 'warning'; text: string } | null {
  if (result?.undeploy) {
    return { tone: 'info', text: `${result.undeploy.runnerLabel} was asked to delete its stack (only a stack tagged for this pipeline); the outcome is recorded in the audit log as pipeline.undeploy.complete.` };
  }
  if (result?.stackRetained) {
    const r = result.stackRetained;
    const why = reasonText(r.reason) ?? 'No runner could remove it';
    return { tone: 'warning', text: `${stackName(r)} stays in your AWS account: ${why.charAt(0).toLowerCase()}${why.slice(1)}. ${REMOVE_IT.charAt(0).toUpperCase()}${REMOVE_IT.slice(1)}.` };
  }
  return null;
}

/** A purge refused (409) because the stack is still deployed and no runner can remove it. */
export function purgeRefusedCopy(details: Record<string, unknown> | undefined): string | null {
  if (!details || !('stackRetainedReason' in details || 'stackName' in details)) return null;
  const name = stackName({ stackName: typeof details.stackName === 'string' ? details.stackName : null, region: typeof details.region === 'string' ? details.region : null });
  const why = reasonText(typeof details.stackRetainedReason === 'string' ? details.stackRetainedReason : null) ?? 'No runner can remove it';
  return `Not purged: ${name} is still deployed. ${why}, so ${REMOVE_IT}, deregister it on the Deployments page, then purge again.`;
}

/**
 * A purge refused (409 `DEPLOY_IN_PROGRESS`, `details.requestId`) because a
 * deploy of the pipeline through a runner is in flight — refused even forced,
 * since the stack is being created under it. The copy, and the deploy to cancel.
 */
export function purgeDeployInProgressCopy(code: string | undefined, details: Record<string, unknown> | undefined): { text: string; requestId: string } | null {
  if (code !== 'DEPLOY_IN_PROGRESS' || typeof details?.requestId !== 'string' || !details.requestId) return null;
  return {
    text: 'Not purged: this pipeline is being deployed through a pipeline runner right now. Cancel the deploy (or wait for it to finish), then purge it again.',
    requestId: details.requestId,
  };
}

/**
 * A pipeline tombstone past its purge date. The retention sweep keeps one that is
 * still registered as deployed (`deployment` set), or that has a deploy through a
 * runner in flight (`deployment` null), until it is purged by hand. Null while the
 * date is still ahead (or unknown), when the date itself is what to show.
 */
export function keptPastPurgeCopy(
  deployment: { stackRemovedOnPurge: boolean } | null | undefined,
  purgeAfter: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const due = purgeAfter ? Date.parse(purgeAfter) : NaN;
  if (!Number.isFinite(due) || due > now) return null;
  if (deployment === null) return 'Kept: a deploy through a runner is in flight. Purge it once the deploy has finished.';
  if (deployment === undefined) return 'Kept past its purge date: it may still be deployed. Purge it by hand.';
  return deployment.stackRemovedOnPurge
    ? 'Kept: still deployed. Purge it to remove the stack.'
    : 'Kept: still deployed. Remove its stack and deregister it, then purge it.';
}
