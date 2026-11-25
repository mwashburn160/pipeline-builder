// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner's DEPLOY actions — opt-in (`infra setup-runner --enable-deploy`,
 * stack parameter EnableDeploy). The Lambda cannot run `cdk`, so a deploy
 * starts the runner stack's own CodeBuild project
 * (`pipeline-builder-runner-deploy-<runnerId>`), which runs
 * `pipeline-manager pipeline deploy-job` on the pipeline's managed cdk-synth
 * image. Every decision that matters is made here, from the stack's settings,
 * never from the request:
 *
 *   deploy / undeploy (claims validated by runner-jws.ts):
 *     1. DEPLOY_NOT_ENABLED without EnableDeploy;
 *     2. the claim's region and pipeline name inside the local allowlist, else
 *        RUNNER_REFUSED;
 *     3. deploy only (after step 4's own-build check): a pipeline already tagged `pb.pipeline-id = <id>` in the
 *        account → PIPELINE_ALREADY_DEPLOYED (the platform links it instead);
 *     4. the project's recent builds: this request's own build, in any state,
 *        is returned (a redelivery starts nothing); another request's running
 *        build of the same pipeline → DEPLOY_IN_PROGRESS;
 *     5. the grant from the signed claim is KMS-encrypted with the stack's key
 *        under {@link deployGrantEncryptionContext} (runner id + request id) — only that ciphertext
 *        reaches the build (CodeBuild env overrides are readable through
 *        BatchGetBuilds and logged by CloudTrail);
 *     6. StartBuild with idempotencyToken = jti, the image
 *        `<REGISTRY_PULL_HOST>/system/cdk-synth@<digest>` (the host is the
 *        stack's), the stack's registry credential, and ONLY the
 *        {@link DEPLOY_JOB_OVERRIDE_ENV} names — never a buildspec, role,
 *        timeout or privileged-mode override.
 *   deploy_status / deploy_cancel: BatchGetBuilds of the claimed build — it
 *     must be this runner's project and carry the claimed request (and
 *     pipeline) id, else RUNNER_REFUSED; the answer is the normalized state,
 *     the job's exported stage and result code (fixed vocabularies; anything
 *     else is dropped) — never a log, message or ARN. Cancel = StopBuild.
 *
 * The grant and its ciphertext are never logged or returned.
 */

import {
  BatchGetBuildsCommand, ListBuildsForProjectCommand, StartBuildCommand, StopBuildCommand,
} from '@aws-sdk/client-codebuild';
import { EncryptCommand } from '@aws-sdk/client-kms';
import {
  DEPLOY_JOB_ENV, DEPLOY_JOB_IMAGE_REPOSITORY, DEPLOY_STAGES, deployBuildState, deployGrantEncryptionContext, isDeployJobResultCode,
  type DeployBuildState, type DeployJobResultCode, type DeployStage, type RunClaims,
} from '@pipeline-builder/api-core/pipeline-runners';
import type { Sender } from './pipeline-tag.js';

/** The deploy half of the runner's configuration (all from the stack; `enabled: false` = EnableDeploy off). */
export type DeployConfig =
  | { enabled: false }
  | { enabled: true; projectName: string; registryPullHost: string; registryCredentialSecret: string; grantKeyArn: string };

/** A registry host as the stack passes it: `host` or `host:port`. */
export const REGISTRY_PULL_HOST_PATTERN = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

/** Read the deploy settings; throws (the runner is misconfigured) when EnableDeploy is on and one is missing. */
export function deployConfigFromEnv(env: Record<string, string | undefined>): DeployConfig {
  if (env.DEPLOY_ENABLED?.trim() !== 'true') return { enabled: false };
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} environment variable is required when DEPLOY_ENABLED=true`);
    return v;
  };
  const registryPullHost = need('REGISTRY_PULL_HOST');
  if (!REGISTRY_PULL_HOST_PATTERN.test(registryPullHost)) throw new Error('REGISTRY_PULL_HOST must be a host or host:port');
  return {
    enabled: true,
    projectName: need('DEPLOY_PROJECT_NAME'),
    registryPullHost,
    registryCredentialSecret: need('REGISTRY_CREDENTIAL_SECRET'),
    grantKeyArn: need('DEPLOY_GRANT_KEY_ARN'),
  };
}

/** What a deploy action answers: an outcome with its details, or a refusal code. */
export type DeployAnswer =
  | { outcome: 'deploying' | 'undeploying'; buildId: string }
  | { outcome: 'deploy_status'; buildState: DeployBuildState; stage: DeployStage | null; resultCode: DeployJobResultCode | null }
  | { outcome: 'deploy_cancelled'; buildState: DeployBuildState }
  | { refuse: 'DEPLOY_NOT_ENABLED' | 'RUNNER_REFUSED' | 'PIPELINE_ALREADY_DEPLOYED' | 'DEPLOY_IN_PROGRESS' | 'DEPLOY_BUSY' | 'DEPLOY_BUILD_NOT_FOUND' };

export interface DeployContext {
  runnerId: string;
  config: DeployConfig;
  codebuild: Sender;
  kms: Sender;
  /** The local allowlist (region + pipeline name). */
  isAllowed(region: string, pipelineName: string): boolean;
  /** Whether a pipeline tagged with this id already exists in the account (any allowlisted region). */
  alreadyDeployed(pipelineId: string): Promise<boolean>;
}

interface Build {
  id?: string;
  projectName?: string;
  buildStatus?: string;
  environment?: { environmentVariables?: Array<{ name?: string; value?: string }> };
  exportedEnvironmentVariables?: Array<{ name?: string; value?: string }>;
  phases?: Array<{ phaseType?: string; phaseStatus?: string }>;
}

const errName = (err: unknown): string => String((err as { name?: string })?.name ?? '');
const envOf = (b: Build, name: string): string | undefined => b.environment?.environmentVariables?.find((v) => v.name === name)?.value;
const exportedOf = (b: Build, name: string): string | undefined => b.exportedEnvironmentVariables?.find((v) => v.name === name)?.value;

/**
 * The project's newest builds, any state. One page (100, newest first) covers
 * every build a live request can have started: ConcurrentBuildLimit is at most
 * 20 and a request lives 10 minutes.
 */
async function recentBuilds(ctx: DeployContext, projectName: string): Promise<Build[]> {
  const listed = await ctx.codebuild.send(new ListBuildsForProjectCommand({ projectName, sortOrder: 'DESCENDING' })) as { ids?: string[] };
  const ids = (listed.ids ?? []).slice(0, 100);
  if (ids.length === 0) return [];
  const got = await ctx.codebuild.send(new BatchGetBuildsCommand({ ids })) as { builds?: Build[] };
  return got.builds ?? [];
}

/** deploy / undeploy: start (or find) the job's build. */
async function startJob(ctx: DeployContext, claims: RunClaims): Promise<DeployAnswer> {
  const cfg = ctx.config;
  if (!cfg.enabled) return { refuse: 'DEPLOY_NOT_ENABLED' };
  const d = claims.deploy!;
  const pipelineId = claims.pipelineId!;
  if (!ctx.isAllowed(d.region, d.pipelineName)) return { refuse: 'RUNNER_REFUSED' };

  // This request's own build, in ANY state: a redelivery (the other container,
  // after CodeBuild's 5-minute idempotency window) must return it, not start a
  // second build that would only burn the already-used grant — and not answer
  // PIPELINE_ALREADY_DEPLOYED for the pipeline that build just deployed.
  const builds = await recentBuilds(ctx, cfg.projectName);
  const own = builds.find((b) => b.id && envOf(b, DEPLOY_JOB_ENV.requestId) === claims.jti);
  if (own?.id) return { outcome: d.mode === 'deploy' ? 'deploying' : 'undeploying', buildId: own.id };
  if (d.mode === 'deploy' && await ctx.alreadyDeployed(pipelineId)) return { refuse: 'PIPELINE_ALREADY_DEPLOYED' };
  if (builds.some((b) => deployBuildState(b.buildStatus) === 'in_progress' && envOf(b, DEPLOY_JOB_ENV.pipelineId) === pipelineId)) {
    return { refuse: 'DEPLOY_IN_PROGRESS' };
  }

  const encrypted = await ctx.kms.send(new EncryptCommand({
    KeyId: cfg.grantKeyArn,
    Plaintext: Buffer.from(d.grant, 'utf8'),
    // Bound to this request (= the build's PB_REQUEST_ID): the ciphertext decrypts for its own build only.
    EncryptionContext: deployGrantEncryptionContext(ctx.runnerId, claims.jti),
  })) as { CiphertextBlob?: Uint8Array };
  if (!encrypted.CiphertextBlob || encrypted.CiphertextBlob.length === 0) throw new Error('KMS returned no ciphertext');
  const ciphertext = Buffer.from(encrypted.CiphertextBlob).toString('base64');

  // Exactly DEPLOY_JOB_OVERRIDE_ENV, every value from the validated claim (or the ciphertext).
  const env: Record<(typeof DEPLOY_JOB_ENV)[keyof typeof DEPLOY_JOB_ENV], string> = {
    [DEPLOY_JOB_ENV.requestId]: claims.jti,
    [DEPLOY_JOB_ENV.pipelineId]: pipelineId,
    [DEPLOY_JOB_ENV.region]: d.region,
    [DEPLOY_JOB_ENV.pipelineName]: d.pipelineName,
    [DEPLOY_JOB_ENV.stackName]: d.stackName,
    [DEPLOY_JOB_ENV.grantCiphertext]: ciphertext,
    [DEPLOY_JOB_ENV.toolchainRelease]: d.toolchainRelease,
    [DEPLOY_JOB_ENV.protocol]: String(d.protocol),
    [DEPLOY_JOB_ENV.mode]: d.mode,
  } as Record<(typeof DEPLOY_JOB_ENV)[keyof typeof DEPLOY_JOB_ENV], string>;

  let started: { build?: { id?: string } };
  try {
    started = await ctx.codebuild.send(new StartBuildCommand({
      projectName: cfg.projectName,
      // A redelivery within CodeBuild's token window starts ONE build (the scan above covers the rest).
      idempotencyToken: claims.jti,
      imageOverride: `${cfg.registryPullHost}/${DEPLOY_JOB_IMAGE_REPOSITORY}@${d.image.digest}`,
      imagePullCredentialsTypeOverride: 'SERVICE_ROLE',
      registryCredentialOverride: { credential: cfg.registryCredentialSecret, credentialProvider: 'SECRETS_MANAGER' },
      environmentVariablesOverride: Object.entries(env).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
    })) as { build?: { id?: string } };
  } catch (err) {
    // ConcurrentBuildLimit reached: the platform delivers again.
    if (errName(err) === 'AccountLimitExceededException') return { refuse: 'DEPLOY_BUSY' };
    throw err;
  }
  if (!started.build?.id) throw new Error('StartBuild returned no build id');
  return { outcome: d.mode === 'deploy' ? 'deploying' : 'undeploying', buildId: started.build.id };
}

/** The claimed build, only when it is this runner's project's build of the claimed request and pipeline. */
async function ownBuild(ctx: DeployContext, claims: RunClaims): Promise<Build | DeployAnswer> {
  const cfg = ctx.config;
  if (!cfg.enabled) return { refuse: 'DEPLOY_NOT_ENABLED' };
  const buildId = claims.buildId!;
  // A build id is `<project>:<uuid>`: another project's is refused before any call.
  if (!buildId.startsWith(`${cfg.projectName}:`)) return { refuse: 'RUNNER_REFUSED' };
  const got = await ctx.codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] })) as { builds?: Build[] };
  const b = (got.builds ?? []).find((x) => x.id === buildId);
  if (!b) return { refuse: 'DEPLOY_BUILD_NOT_FOUND' };
  if (b.projectName !== cfg.projectName) return { refuse: 'RUNNER_REFUSED' };
  if (envOf(b, DEPLOY_JOB_ENV.requestId) !== claims.deployRequestId) return { refuse: 'RUNNER_REFUSED' };
  if (envOf(b, DEPLOY_JOB_ENV.pipelineId) !== claims.pipelineId) return { refuse: 'RUNNER_REFUSED' };
  return b;
}
const isAnswer = (v: Build | DeployAnswer): v is DeployAnswer => 'refuse' in v || 'outcome' in v;

/** The job's exported stage / result, only when inside the fixed vocabularies. */
function reported(b: Build, state: DeployBuildState): { stage: DeployStage | null; resultCode: DeployJobResultCode | null } {
  const rawStage = exportedOf(b, DEPLOY_JOB_ENV.stage);
  const rawResult = exportedOf(b, DEPLOY_JOB_ENV.result);
  let stage: DeployStage | null = (DEPLOY_STAGES as readonly string[]).includes(rawStage ?? '') ? rawStage as DeployStage : null;
  let resultCode: DeployJobResultCode | null = isDeployJobResultCode(rawResult) ? rawResult : null;
  // The job never ran: the build failed bringing up its image (pull / credential).
  if (state === 'failed' && !resultCode && b.phases?.some((p) => p.phaseType === 'PROVISIONING' && p.phaseStatus === 'FAILED')) {
    resultCode = 'DEPLOY_IMAGE_PULL_FAILED';
    stage = stage ?? 'starting';
  }
  return { stage, resultCode };
}

async function buildStatus(ctx: DeployContext, claims: RunClaims): Promise<DeployAnswer> {
  const b = await ownBuild(ctx, claims);
  if (isAnswer(b)) return b;
  const buildState = deployBuildState(b.buildStatus);
  return { outcome: 'deploy_status', buildState, ...reported(b, buildState) };
}

async function cancelBuild(ctx: DeployContext, claims: RunClaims): Promise<DeployAnswer> {
  const b = await ownBuild(ctx, claims);
  if (isAnswer(b)) return b;
  const current = deployBuildState(b.buildStatus);
  // Finished already: nothing to stop; the poll records how it ended.
  if (current !== 'in_progress') return { outcome: 'deploy_cancelled', buildState: current };
  const stopped = await ctx.codebuild.send(new StopBuildCommand({ id: b.id! })) as { build?: { buildStatus?: string } };
  return { outcome: 'deploy_cancelled', buildState: deployBuildState(stopped.build?.buildStatus) };
}

/** Act on one verified deploy-family request. */
export async function runDeployAction(ctx: DeployContext, claims: RunClaims): Promise<DeployAnswer> {
  switch (claims.action) {
    case 'deploy':
    case 'undeploy':
      return startJob(ctx, claims);
    case 'deploy_status':
      return buildStatus(ctx, claims);
    case 'deploy_cancel':
      return cancelBuild(ctx, claims);
    default:
      throw new Error(`not a deploy action: ${claims.action}`);
  }
}
