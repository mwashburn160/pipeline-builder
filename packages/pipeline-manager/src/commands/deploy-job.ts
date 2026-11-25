// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline-manager pipeline deploy-job` (hidden) — the job the runner's
 * deploy CodeBuild project runs (runner-stack.json DeployProject), on the
 * pipeline's own managed cdk-synth image pinned by digest. Never run by hand:
 * everything comes from the build's environment — the project's PLATFORM_BASE_URL,
 * PB_RUNNER_ID, PB_CDK_QUALIFIER and the runner's per-request overrides
 * (api-core DEPLOY_JOB_ENV) — and its only output is a result CODE from a
 * fixed list (DEPLOY_JOB_RESULT_CODES) plus the stage it ended in, written to
 * `--result-file` for the buildspec to export (PB_DEPLOY_RESULT /
 * PB_DEPLOY_STAGE) and posted to the platform.
 *
 * deploy mode, in order (the stage each step reports):
 *   starting        read the job's env (a missing value: DEPLOY_JOB_ERROR);
 *   authenticating  KMS-decrypt the grant (encryption context
 *                   {runnerId, purpose: deploy-grant, requestId}: only this stack's deploy
 *                   role may), exchange it ONCE for a session, then scrub the
 *                   ciphertext from the environment — no child process ever
 *                   sees it, and the grant, ciphertext and session token are
 *                   never printed; the env's and the session's protocol must
 *                   be this CLI's DEPLOY_JOB_PROTOCOL_VERSION
 *                   (DEPLOY_JOB_PROTOCOL_MISMATCH), and the session's names
 *                   the request's (DEPLOY_TARGET_MISMATCH);
 *   fetching        fetchPipelineProps through the session facade (the same
 *                   resolution `pipeline deploy` runs); the pipeline must still
 *                   name the requested pipeline / stack and toolchain release;
 *   prechecking     the region's CDK bootstrap (never bootstraps:
 *                   CDK_NOT_BOOTSTRAPPED / CDK_BOOTSTRAP_OUTDATED naming
 *                   `pipeline-manager infra bootstrap`); assume the bootstrap
 *                   deploy + file-publishing roles (DEPLOY_PERMISSION_DENIED);
 *                   the target stack's state, read through the deploy role:
 *                     absent                          → deploy;
 *                     tagged pb.pipeline-id = another → STACK_OWNED_BY_OTHER_PIPELINE;
 *                     untagged                        → STACK_OWNED_BY_OTHER_PIPELINE;
 *                     this pipeline's ROLLBACK_COMPLETE, or DELETE_FAILED that
 *                     never completed (a failed first deploy) → cleaning;
 *                     this pipeline's DELETE_FAILED that once completed → STACK_DELETE_FAILED;
 *                     this pipeline's, any other state → deploy over it;
 *   cleaning        delete it through the bootstrap roles and wait for
 *                   DELETE_COMPLETE (STACK_DELETE_FAILED);
 *   synthesizing    `cdk synth` into a cloud assembly, then check it: the
 *                   stack name / region (DEPLOY_TARGET_MISMATCH), no Docker
 *                   image asset (the build is not privileged:
 *                   DEPLOY_NEEDS_PRIVILEGED — none exist today, see
 *                   utils/deploy-assembly.ts), and every pipeline-builder/…
 *                   secret its CodeBuild projects read exists in the region
 *                   (ACCOUNT_SECRETS_MISSING);
 *   deploying       re-read the stack (one of that name that appeared since the
 *                   precheck and is not this pipeline's: STACK_OWNED_BY_OTHER_PIPELINE),
 *                   then `cdk deploy` of exactly that assembly through runDeploy
 *                   (CFN_DEPLOY_FAILED);
 *   registering     the registry row through the session (org / pipeline /
 *                   runner forced by the platform) — best effort: the
 *                   platform's `deployed` status fallback registers too;
 *   done            OK.
 * undeploy mode (PB_JOB_MODE=undeploy, sent on purge): authenticate, check
 * the bootstrap, then (removing) delete the stack ONLY when it is tagged
 * pb.pipeline-id = this pipeline; an absent stack is already OK.
 *
 * `--protocol` prints DEPLOY_JOB_PROTOCOL_VERSION and exits: what a toolchain
 * release records for the cdk-synth image it ships.
 */

import { chmodSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CloudFormationClient, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  DEPLOY_JOB_ENV, DEPLOY_JOB_MODES, DEPLOY_JOB_PROTOCOL_VERSION, DEPLOY_RESULT_OK, PIPELINE_ID_TAG, deployGrantEncryptionContext,
  type DeployJobMode, type DeployJobResultCode, type DeploySessionDto, type DeployStage,
} from '@pipeline-builder/api-core/pipeline-runners';
import { deployedPipelineNames } from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import { assertShellSafe, shellQuote } from '../config/cli.constants.js';
import type { Pipeline } from '../types/index.js';
import type { PlatformReadClient } from '../utils/api-client.js';
import { bootstrapCommandHint, cdkBootstrapRoleArn, MIN_CDK_BOOTSTRAP_VERSION, readBootstrapVersion } from '../utils/cdk-bootstrap.js';
import { executeCdkShellCommand, resolveBoilerplatePath } from '../utils/cdk-utils.js';
import { assemblyStack, dockerImageAssetCount, templateSecretNames } from '../utils/deploy-assembly.js';
import { runDeploy, type RunDeployInput } from '../utils/deploy-runner.js';
import {
  DeployGrantRefusedError, DeploySessionClient, defaultSessionHttp, exchangeDeployGrant, isDeploySessionEnded, type SessionHttp,
} from '../utils/deploy-session-client.js';
import { printError, printInfo, printSuccess, printWarning } from '../utils/output-utils.js';
import { fetchPipelineProps } from '../utils/pipeline-config.js';
import { PluginResolutionError } from '../utils/plugin-resolver.js';
import { withPropsFile } from '../utils/props-file.js';
import { readStepManifest } from '../utils/registry.js';

export { MIN_CDK_BOOTSTRAP_VERSION };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Dependencies (all injectable) ───────────────────────────────────────────

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

/** A stack as the job sees it: its status and tags. */
export interface StackState { status: string; tags: Record<string, string> }

/** CloudFormation through an assumed bootstrap role. */
export interface StackOps {
  describe(stackName: string): Promise<StackState | undefined>;
  /** Whether the stack ever reached CREATE_COMPLETE / UPDATE_COMPLETE (its own events). */
  everCompleted(stackName: string): Promise<boolean>;
  /** DeleteStack (with the bootstrap CloudFormation execution role) and wait for DELETE_COMPLETE; throws otherwise. */
  delete(stackName: string, cfnExecRoleArn: string): Promise<void>;
}

export interface DeployJobDeps {
  decryptGrant(ciphertextBase64: string, context: Record<string, string>): Promise<string>;
  http: SessionHttp;
  caller(): Promise<{ accountId: string; partition: string }>;
  bootstrapVersion(region: string, qualifier: string): Promise<number | undefined>;
  assumeRole(roleArn: string, region: string): Promise<AwsCredentials>;
  stacks(region: string, credentials: AwsCredentials): StackOps;
  secretExists(name: string, region: string): Promise<boolean>;
  fetchPipeline(client: PlatformReadClient, pipelineId: string): Promise<{ pipeline: Pick<Pipeline, 'id' | 'orgId' | 'pipelineName' | 'project' | 'organization'>; propsWithIds: Record<string, unknown> }>;
  synth(input: { propsWithIds: Record<string, unknown>; output: string; region: string; accountId: string; platformBaseUrl: string }): Promise<void>;
  deploy(input: RunDeployInput): Promise<void>;
}

/** The job's settings, from the build's environment. */
interface JobEnv {
  platformBaseUrl: string;
  runnerId: string;
  qualifier: string;
  requestId: string;
  pipelineId: string;
  region: string;
  pipelineName: string;
  stackName: string;
  ciphertext: string;
  toolchainRelease: string;
  protocol: number;
  mode: DeployJobMode;
}

/** A refusal with its result code (the stage is the one the job was in). */
class JobFailure extends Error {
  constructor(readonly code: Exclude<DeployJobResultCode, typeof DEPLOY_RESULT_OK>, message: string) {
    super(message);
    this.name = 'JobFailure';
  }
}

const errName = (err: unknown): string => String((err as { name?: string })?.name ?? '');
const ACCESS_DENIED = new Set(['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'AuthorizationErrorException', 'KMSInvalidStateException']);
const isAccessDenied = (err: unknown): boolean => ACCESS_DENIED.has(errName(err));

function readJobEnv(env: Record<string, string | undefined>): JobEnv {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new JobFailure('DEPLOY_JOB_ERROR', `The deploy job's ${name} is not set — this command runs only inside the runner's deploy project`);
    return v;
  };
  const mode = need(DEPLOY_JOB_ENV.mode);
  if (!(DEPLOY_JOB_MODES as readonly string[]).includes(mode)) throw new JobFailure('DEPLOY_JOB_ERROR', `Unknown ${DEPLOY_JOB_ENV.mode} "${mode}"`);
  const platformBaseUrl = need('PLATFORM_BASE_URL').replace(/\/+$/, '');
  // The grant and the session token travel to this URL: never in clear text in
  // production (the runner Lambda holds its own copy of the URL to the same rule).
  if (env.NODE_ENV === 'production' && !/^https:\/\//.test(platformBaseUrl)) {
    throw new JobFailure('DEPLOY_JOB_ERROR', 'PLATFORM_BASE_URL must be https');
  }
  return {
    platformBaseUrl,
    runnerId: need('PB_RUNNER_ID'),
    qualifier: need('PB_CDK_QUALIFIER'),
    requestId: need(DEPLOY_JOB_ENV.requestId),
    pipelineId: need(DEPLOY_JOB_ENV.pipelineId),
    region: need(DEPLOY_JOB_ENV.region),
    pipelineName: need(DEPLOY_JOB_ENV.pipelineName),
    stackName: need(DEPLOY_JOB_ENV.stackName),
    ciphertext: need(DEPLOY_JOB_ENV.grantCiphertext),
    toolchainRelease: need(DEPLOY_JOB_ENV.toolchainRelease),
    protocol: Number(need(DEPLOY_JOB_ENV.protocol)),
    mode: mode as DeployJobMode,
  };
}

/** The result file the buildspec's post_build exports from: one code, one stage, nothing else. */
function writeResultFile(file: string, code: DeployJobResultCode, stage: DeployStage): void {
  writeFileSync(file, `${DEPLOY_JOB_ENV.result}=${code}\n${DEPLOY_JOB_ENV.stage}=${stage}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ─── The job ─────────────────────────────────────────────────────────────────

export interface DeployJobInput {
  /** The build's environment (process.env in the build). The ciphertext is deleted from it once unwrapped. */
  env: Record<string, string | undefined>;
  resultFile: string;
  /** Where the cloud assembly is synthesized. */
  output: string;
  deps: DeployJobDeps;
  /** How often the session is re-checked (a progress post) while `cdk deploy` runs; default {@link DEPLOY_HEARTBEAT_MS}. */
  heartbeatMs?: number;
}

/** While `cdk deploy` runs, the session is re-checked this often: a 401 (cancelled / past the deadline) stops cdk. */
export const DEPLOY_HEARTBEAT_MS = 30_000;

/** The session is gone: the job stops where it is. */
const sessionEnded = (): JobFailure => new JobFailure('DEPLOY_CANCELLED', 'The platform ended this deploy (cancelled, or past its deadline): stopping');

/** Run the job; never throws. The code is OK or a RUNNER_DEPLOY_ERRORS code. */
export async function runDeployJob(input: DeployJobInput): Promise<{ code: DeployJobResultCode; stage: DeployStage }> {
  const { deps } = input;
  let stage: DeployStage = 'starting';
  let session: DeploySessionClient | undefined;
  const enter = async (next: DeployStage): Promise<void> => {
    stage = next;
    printInfo(`Deploy job: ${next}`);
    // Progress is a hint (the status poll decides): a failed post never fails
    // the job — except a 401, which means the session was wiped (the deploy was
    // cancelled or passed its deadline): nothing more may run.
    if (session) {
      await session.progress(next).catch((err: unknown) => {
        if (isDeploySessionEnded(err)) throw sessionEnded();
      });
    }
  };

  let code: DeployJobResultCode = DEPLOY_RESULT_OK;
  try {
    const job = readJobEnv(input.env);
    await enter('authenticating');
    const dto = await authenticate(job, input, deps);
    session = new DeploySessionClient({ baseUrl: job.platformBaseUrl, session: dto, http: deps.http });
    checkSession(job, dto);
    if (job.mode === 'undeploy') {
      await undeploy(job, deps, enter);
    } else {
      await deploy(job, input, deps, session, enter);
    }
    stage = 'done';
    printSuccess(job.mode === 'undeploy' ? 'The pipeline\'s stack is removed' : 'The pipeline is deployed');
  } catch (err) {
    if (err instanceof JobFailure) {
      code = err.code;
      printError(`Deploy job failed (${err.code}) while ${stage}: ${err.message}`);
    } else {
      code = 'DEPLOY_JOB_ERROR';
      printError(`Deploy job failed unexpectedly while ${stage}`, { error: errName(err) || 'Error', message: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    writeResultFile(input.resultFile, code, stage);
  } catch (err) {
    printWarning('Could not write the deploy result file', { error: err instanceof Error ? err.message : String(err) });
  }
  if (session) await session.result({ code, stage }).catch(() => printWarning('Could not post the deploy result (the status poll reads it from the build)'));
  return { code, stage };
}

/** KMS-unwrap the grant, scrub it from the env, exchange it for a session. */
async function authenticate(job: JobEnv, input: DeployJobInput, deps: DeployJobDeps): Promise<DeploySessionDto> {
  let grant: string;
  try {
    grant = await deps.decryptGrant(job.ciphertext, deployGrantEncryptionContext(job.runnerId, job.requestId));
  } catch (err) {
    if (isAccessDenied(err)) throw new JobFailure('DEPLOY_PERMISSION_DENIED', 'The grant key refused this build\'s role (kms:Decrypt) — redeploy the runner stack');
    throw new JobFailure('DEPLOY_GRANT_REJECTED', 'The deploy grant could not be unwrapped');
  } finally {
    // No later step — and no child process (cdk) — ever sees the ciphertext.
    delete input.env[DEPLOY_JOB_ENV.grantCiphertext];
    delete process.env[DEPLOY_JOB_ENV.grantCiphertext];
  }

  try {
    return await exchangeDeployGrant({ requestId: job.requestId, grant, http: deps.http });
  } catch (err) {
    if (err instanceof DeployGrantRefusedError) {
      throw new JobFailure(err.reason === 'expired' ? 'DEPLOY_GRANT_EXPIRED' : 'DEPLOY_GRANT_REJECTED', err.message);
    }
    throw new JobFailure('PIPELINE_FETCH_FAILED', `The platform could not be reached to start the deploy session: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    grant = '';
  }
}

/** The session's protocol and names must be this image's and the request's (reported through the session). */
function checkSession(job: JobEnv, dto: DeploySessionDto): void {
  if (job.protocol !== DEPLOY_JOB_PROTOCOL_VERSION || dto.protocol !== DEPLOY_JOB_PROTOCOL_VERSION) {
    throw new JobFailure('DEPLOY_JOB_PROTOCOL_MISMATCH',
      `This image speaks deploy-job protocol ${DEPLOY_JOB_PROTOCOL_VERSION}; the request speaks ${job.protocol} (session ${dto.protocol})`);
  }
  const same = dto.pipelineId === job.pipelineId && dto.region === job.region && dto.pipelineName === job.pipelineName
    && dto.stackName === job.stackName && dto.toolchainRelease === job.toolchainRelease;
  if (!same) throw new JobFailure('DEPLOY_TARGET_MISMATCH', 'The deploy session names another pipeline, stack, region or release than the request');
}

/** Check the region's bootstrap and assume the given bootstrap roles (the first one's credentials are returned). */
async function precheck(job: JobEnv, deps: DeployJobDeps, kinds: string[]): Promise<{ deployRole: AwsCredentials; accountId: string; partition: string }> {
  let version: number | undefined;
  try {
    version = await deps.bootstrapVersion(job.region, job.qualifier);
  } catch (err) {
    if (isAccessDenied(err)) throw new JobFailure('DEPLOY_PERMISSION_DENIED', `Reading the CDK bootstrap version in ${job.region} was refused`);
    throw err;
  }
  if (version === undefined) {
    throw new JobFailure('CDK_NOT_BOOTSTRAPPED', `${job.region} has no CDK bootstrap (qualifier ${job.qualifier}). Run: ${bootstrapCommandHint(job.region, job.qualifier)}`);
  }
  if (version < MIN_CDK_BOOTSTRAP_VERSION) {
    throw new JobFailure('CDK_BOOTSTRAP_OUTDATED',
      `${job.region}'s CDK bootstrap is version ${version}; deploys need ${MIN_CDK_BOOTSTRAP_VERSION} or newer. Run: ${bootstrapCommandHint(job.region, job.qualifier)}`);
  }
  const { accountId, partition } = await deps.caller();
  let first: AwsCredentials | undefined;
  for (const kind of kinds) {
    try {
      const creds = await deps.assumeRole(cdkBootstrapRoleArn(partition, accountId, job.qualifier, kind, job.region), job.region);
      first ??= creds;
    } catch (err) {
      if (isAccessDenied(err) || errName(err) === 'NoSuchEntity') {
        throw new JobFailure('DEPLOY_PERMISSION_DENIED', `The deploy role could not assume the CDK ${kind} role in ${job.region}`);
      }
      throw err;
    }
  }
  return { deployRole: first!, accountId, partition };
}

/** Whose the target stack is. */
function owner(state: StackState, pipelineId: string): 'mine' | 'other' {
  return state.tags[PIPELINE_ID_TAG] === pipelineId ? 'mine' : 'other';
}

async function deleteStack(ops: StackOps, job: JobEnv, partition: string, accountId: string): Promise<void> {
  try {
    await ops.delete(job.stackName, cdkBootstrapRoleArn(partition, accountId, job.qualifier, 'cfn-exec', job.region));
  } catch (err) {
    if (isAccessDenied(err)) throw new JobFailure('DEPLOY_PERMISSION_DENIED', `Deleting stack ${job.stackName} was refused`);
    throw new JobFailure('STACK_DELETE_FAILED', `Stack ${job.stackName} did not reach DELETE_COMPLETE: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deploy(
  job: JobEnv, input: DeployJobInput, deps: DeployJobDeps, session: DeploySessionClient, enter: (s: DeployStage) => Promise<void>,
): Promise<void> {
  await enter('fetching');
  let fetched: Awaited<ReturnType<DeployJobDeps['fetchPipeline']>>;
  try {
    fetched = await deps.fetchPipeline(session, job.pipelineId);
  } catch (err) {
    if (isDeploySessionEnded(err)) throw sessionEnded();
    if (err instanceof PluginResolutionError) throw new JobFailure('PLUGIN_RESOLUTION_FAILED', err.message);
    throw new JobFailure('PIPELINE_FETCH_FAILED', `The pipeline could not be read through the deploy session: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { pipeline, propsWithIds } = fetched;
  // The stack is tagged pb.pipeline-id from these props, and every ownership
  // check below compares that tag with the request's id: they must be one id.
  if (pipeline.id !== job.pipelineId || propsWithIds.pipelineId !== job.pipelineId) {
    throw new JobFailure('DEPLOY_TARGET_MISMATCH', 'The deploy session answered with another pipeline than the request\'s');
  }
  const names = deployedPipelineNames({ pipelineName: pipeline.pipelineName, project: pipeline.project, organization: pipeline.organization, props: propsWithIds });
  if (names.pipelineName !== job.pipelineName || names.stackName !== job.stackName) {
    throw new JobFailure('DEPLOY_TARGET_MISMATCH',
      `The pipeline now deploys as ${names.pipelineName} / ${names.stackName}, not the requested ${job.pipelineName} / ${job.stackName}`);
  }
  const release = (propsWithIds.resolvedBootstrap as { toolchain?: { releaseVersion?: string } } | undefined)?.toolchain?.releaseVersion;
  if (release !== job.toolchainRelease) {
    throw new JobFailure('DEPLOY_TARGET_MISMATCH', `The pipeline now resolves toolchain release ${release ?? '(none)'}, not ${job.toolchainRelease} (this image's)`);
  }

  await enter('prechecking');
  const { deployRole, accountId, partition } = await precheck(job, deps, ['deploy', 'file-publishing']);
  const ops = deps.stacks(job.region, deployRole);
  const state = await ops.describe(job.stackName);
  if (state) {
    if (owner(state, job.pipelineId) === 'other') {
      throw new JobFailure('STACK_OWNED_BY_OTHER_PIPELINE', `A stack named ${job.stackName} already exists in ${job.region} and is not this pipeline's`);
    }
    const failedFirst = state.status === 'ROLLBACK_COMPLETE'
      || (state.status === 'DELETE_FAILED' && !(await ops.everCompleted(job.stackName)));
    if (state.status === 'DELETE_FAILED' && !failedFirst) {
      throw new JobFailure('STACK_DELETE_FAILED', `This pipeline's stack ${job.stackName} is DELETE_FAILED after it once deployed — finish deleting it in CloudFormation`);
    }
    if (failedFirst) {
      await enter('cleaning');
      printInfo(`Removing the failed first deploy of ${job.stackName} (${state.status}) before deploying again`);
      await deleteStack(ops, job, partition, accountId);
    }
  }

  await enter('synthesizing');
  const assemblyDir = input.output;
  try {
    await deps.synth({ propsWithIds, output: assemblyDir, region: job.region, accountId, platformBaseUrl: job.platformBaseUrl });
  } catch (err) {
    throw new JobFailure('DEPLOY_JOB_ERROR', `cdk synth failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const stack = assemblyStack(assemblyDir, job.stackName);
  if (!stack || (stack.region !== 'unknown-region' && stack.region !== job.region)) {
    throw new JobFailure('DEPLOY_TARGET_MISMATCH', `The synthesized assembly holds no stack ${job.stackName} for ${job.region}`);
  }
  if (dockerImageAssetCount(assemblyDir) > 0) {
    throw new JobFailure('DEPLOY_NEEDS_PRIVILEGED',
      'The synthesized stack has Docker image assets, which the runner\'s unprivileged deploy build cannot build. Deploy it with `pipeline-manager pipeline deploy` instead.');
  }
  const missing: string[] = [];
  for (const name of templateSecretNames(stack.template)) {
    try {
      if (!(await deps.secretExists(name, job.region))) missing.push(name);
    } catch (err) {
      if (isAccessDenied(err)) throw new JobFailure('DEPLOY_PERMISSION_DENIED', `Describing secret ${name} was refused`);
      throw err;
    }
  }
  if (missing.length > 0) {
    throw new JobFailure('ACCOUNT_SECRETS_MISSING',
      `The pipeline needs secrets this account does not have in ${job.region}: ${missing.join(', ')} (pipeline-manager infra store-token creates the platform ones)`);
  }

  // Re-read the stack right before deploying: one of that name created since the
  // precheck (another pipeline's, through another runner in this account) must
  // not be deployed over.
  const latest = await ops.describe(job.stackName);
  if (latest && owner(latest, job.pipelineId) === 'other') {
    throw new JobFailure('STACK_OWNED_BY_OTHER_PIPELINE', `A stack named ${job.stackName} appeared in ${job.region} while this job ran and is not this pipeline's`);
  }

  // The progress post here is the last check before cdk starts (a 401 stops
  // the job); while cdk runs, a heartbeat re-checks the session and aborts
  // cdk the moment the platform wipes it.
  await enter('deploying');
  const abort = new AbortController();
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating || abort.signal.aborted) return;
    beating = true;
    session.progress('deploying')
      .catch((err: unknown) => {
        if (isDeploySessionEnded(err)) {
          printWarning('The platform ended this deploy while cdk deploy ran: stopping cdk');
          abort.abort();
        }
      })
      .finally(() => { beating = false; });
  }, input.heartbeatMs ?? DEPLOY_HEARTBEAT_MS);
  try {
    await deps.deploy({
      signal: abort.signal,
      pipeline,
      propsWithIds,
      region: job.region,
      requireApproval: 'never',
      // cdk deploys exactly the inspected assembly; its own output goes elsewhere.
      app: assemblyDir,
      output: `${assemblyDir}.deploy`,
      executionId: job.requestId,
      platformBaseUrl: job.platformBaseUrl,
      register: async ({ region }) => {
        await enter('registering');
        const steps = await readStepManifest(assemblyDir);
        try {
          await session.registry({
            pipelineName: job.pipelineName,
            stackName: job.stackName,
            region,
            ...(steps ? { steps: steps as unknown as Array<Record<string, unknown>> } : {}),
          });
          printSuccess('Pipeline registered through the deploy session');
        } catch (err) {
          printWarning('The registry post failed; the platform registers the pipeline when it records the deploy', { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    if (abort.signal.aborted) throw sessionEnded();
    throw new JobFailure('CFN_DEPLOY_FAILED', `cdk deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearInterval(heartbeat);
  }
}

async function undeploy(job: JobEnv, deps: DeployJobDeps, enter: (s: DeployStage) => Promise<void>): Promise<void> {
  await enter('prechecking');
  const { deployRole, accountId, partition } = await precheck(job, deps, ['deploy']);
  await enter('removing');
  const ops = deps.stacks(job.region, deployRole);
  const state = await ops.describe(job.stackName);
  if (!state) {
    printInfo(`Stack ${job.stackName} is not in ${job.region}: nothing to remove`);
    return;
  }
  if (owner(state, job.pipelineId) === 'other') {
    throw new JobFailure('STACK_OWNED_BY_OTHER_PIPELINE', `Stack ${job.stackName} in ${job.region} is not tagged for this pipeline: it is left as it is`);
  }
  await deleteStack(ops, job, partition, accountId);
}

// ─── Real dependencies ───────────────────────────────────────────────────────

/** The real AWS / platform / cdk dependencies inside the deploy build (its role = the stack's DeployRole). */
export function realDeployJobDeps(platformBaseUrl: string): DeployJobDeps {
  const stackRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  return {
    async decryptGrant(ciphertext, context) {
      const out = await new KMSClient({ ...(stackRegion ? { region: stackRegion } : {}) }).send(new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertext, 'base64'), EncryptionContext: context,
      }));
      if (!out.Plaintext) throw new Error('KMS returned no plaintext');
      return Buffer.from(out.Plaintext).toString('utf8');
    },
    http: defaultSessionHttp(platformBaseUrl),
    async caller() {
      const id = await new STSClient({ ...(stackRegion ? { region: stackRegion } : {}) }).send(new GetCallerIdentityCommand({}));
      const partition = /^arn:([^:]+):/.exec(id.Arn ?? '')?.[1] ?? 'aws';
      if (!id.Account) throw new Error('STS returned no account');
      return { accountId: id.Account, partition };
    },
    bootstrapVersion: (region, qualifier) => readBootstrapVersion(region, qualifier),
    async assumeRole(roleArn, region) {
      const out = await new STSClient({ region }).send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'pipeline-builder-deploy-job', DurationSeconds: 3600 }));
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('AssumeRole returned no credentials');
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, ...(c.SessionToken ? { sessionToken: c.SessionToken } : {}) };
    },
    stacks(region, credentials) {
      const cfn = new CloudFormationClient({ region, credentials });
      return {
        async describe(stackName) {
          try {
            const s = (await cfn.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
            if (!s || s.StackStatus === 'DELETE_COMPLETE') return undefined;
            return { status: String(s.StackStatus), tags: Object.fromEntries((s.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])) };
          } catch (err) {
            if (/does not exist/i.test((err as Error)?.message ?? '')) return undefined;
            throw err;
          }
        },
        async everCompleted(stackName) {
          let next: string | undefined;
          do {
            const page = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName, ...(next ? { NextToken: next } : {}) }));
            if ((page.StackEvents ?? []).some((e) => e.LogicalResourceId === stackName && e.ResourceType === 'AWS::CloudFormation::Stack'
              && (e.ResourceStatus === 'CREATE_COMPLETE' || e.ResourceStatus === 'UPDATE_COMPLETE'))) return true;
            next = page.NextToken;
          } while (next);
          return false;
        },
        async delete(stackName, cfnExecRoleArn) {
          await cfn.send(new DeleteStackCommand({ StackName: stackName, RoleARN: cfnExecRoleArn }));
          const res = await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 1800 }, { StackName: stackName });
          if (res.state !== 'SUCCESS') throw new Error(`stack delete ended ${res.state}`);
        },
      };
    },
    async secretExists(name, region) {
      try {
        await new SecretsManagerClient({ region }).send(new DescribeSecretCommand({ SecretId: name }));
        return true;
      } catch (err) {
        if (errName(err) === 'ResourceNotFoundException') return false;
        throw err;
      }
    },
    fetchPipeline: (client, id) => fetchPipelineProps(client, id),
    async synth({ propsWithIds, output, region, accountId, platformBaseUrl: baseUrl }) {
      assertShellSafe(output, 'output');
      const command = `cdk synth --quiet --notices=false --output=${shellQuote(output)} --app="node ${resolveBoilerplatePath(__dirname)}"`;
      withPropsFile(propsWithIds, (propsEnv) => executeCdkShellCommand(command, {
        showOutput: true,
        env: {
          ...propsEnv, AWS_REGION: region, AWS_DEFAULT_REGION: region, CDK_DEFAULT_REGION: region, CDK_DEFAULT_ACCOUNT: accountId, PLATFORM_BASE_URL: baseUrl,
        },
      }));
    },
    deploy: (input) => runDeploy(input),
  };
}

/**
 * Registers the hidden `pipeline deploy-job`.
 */
export function deployJobCommand(pipeline: Command): void {
  pipeline
    .command('deploy-job', { hidden: true })
    .description('The runner\'s deploy job (runs only inside the runner stack\'s deploy CodeBuild project)')
    .option('--result-file <path>', 'Where to write PB_DEPLOY_RESULT / PB_DEPLOY_STAGE for the buildspec to export', '/tmp/pb-deploy-result.env')
    .option('--output <dir>', 'Where the cloud assembly is synthesized', 'cdk.out')
    .option('--protocol', 'Print the deploy-job protocol this CLI speaks and exit', false)
    .action(async (options: { resultFile: string; output: string; protocol: boolean }) => {
      if (options.protocol) {
        process.stdout.write(`${DEPLOY_JOB_PROTOCOL_VERSION}\n`);
        return;
      }
      const baseUrl = (process.env.PLATFORM_BASE_URL ?? '').replace(/\/+$/, '');
      const { code } = await runDeployJob({
        env: process.env,
        resultFile: options.resultFile,
        output: path.resolve(options.output),
        deps: realDeployJobDeps(baseUrl),
      });
      process.exitCode = code === DEPLOY_RESULT_OK ? 0 : 1;
    });
}
