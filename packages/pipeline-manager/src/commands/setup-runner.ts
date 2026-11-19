// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra setup-runner` — install (or update, or remove) a CROSS-ACCOUNT
 * PIPELINE RUNNER in the AWS account the operator's credentials point at.
 *
 * The runner is a Lambda (src/lambda/runner-handler.ts) that starts and stops
 * this account's pipelines with its own role, on requests the platform SIGNS and
 * POSTs to its endpoint. The platform never gets AWS access, a role ARN or this
 * account's number, and the runner holds no platform credential.
 *
 *   install: register a PENDING runner (step-up) → deploy the stack ONCE with
 *     its RUNNER_ID → upload the handler → read the endpoint (Function URL, or
 *     the IP-allowlisted API Gateway) from the stack outputs → PATCH it onto the
 *     runner (step-up). The platform then sends a signed ping addressed to that
 *     id; a `pong` makes the runner active. A runner never answers anyone else.
 *   update (the stack already names a runner): redeploy + upload in place; a
 *     still-pending runner, or one whose endpoint changed, gets the URL PATCHed;
 *     an active one is test-pinged.
 *   --delete: revoke on the platform FIRST (step-up), then delete the stack.
 *   --with-events: afterwards run `infra setup-events --scoped-ingest`, so
 *     executions started through the runner report their status.
 *
 * The endpoint URL is a secret: it is sent to the platform and never printed.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import * as os from 'os';
import path from 'path';
import { CloudFormationClient, DeleteStackCommand, DescribeStacksCommand, waitUntilStackDeleteComplete } from '@aws-sdk/client-cloudformation';
import { LambdaClient, UpdateFunctionCodeCommand, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import {
  RUNNER_ERRORS, RUNNER_FEATURE, type RunnerErrorCode, type RunnerHealth, type RunnerOutcome, type RunnerStatus,
} from '@pipeline-builder/api-core/pipeline-runners';
import { Command } from 'commander';
import { buildStepUpProvider, chooseStepUp } from './store-token.js';
import { APP_VERSION, EVENTS_STACK_NAME } from '../config/cli.constants.js';
import { auditLog } from '../utils/audit-log.js';
import { applyAwsProfile, resolveDeployRegion } from '../utils/aws-env.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withProfileOption, withSslOptions } from '../utils/command-utils.js';
import { getApiConfig } from '../utils/config-loader.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSection, printSuccess, printWarning, setMachineOutput } from '../utils/output-utils.js';
import { ensurePlatformToken } from '../utils/platform-secret.js';
import { extractListPage } from '../utils/response-utils.js';
import {
  buildRunnerTemplate, pipelineActionResources, RUNNER_PIPELINE_ACTIONS, runnerFunctionName,
  runnerStackName, runnerStackParameters,
} from '../utils/runner-template.js';
import { STEP_UP_HEADER, type StepUpProvider } from '../utils/service-account.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUNNERS_ROUTE = '/api/pipelines/runners';

// ─── Plan (pure, offline) ────────────────────────────────────────────────────

export interface RunnerPlanInput {
  label?: string;
  region: string;
  regions?: string;
  pipelinePrefix?: string;
  apiGateway?: boolean;
  allowIp?: string[];
  yes?: boolean;
  delete?: boolean;
  withEvents?: boolean;
}

export interface RunnerPlan {
  label: string;
  /** Where the stack lives. */
  region: string;
  /** Where the runner may act. */
  regions: string[];
  /** Explicit prefixes, or undefined = derive from the org's registered pipeline names. */
  prefixes?: string[];
  apiGateway: boolean;
  allowIps: string[];
  stackName: string;
  functionName: string;
  delete: boolean;
  withEvents: boolean;
}

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const PREFIX_RE = /^[A-Za-z0-9._@-]{1,80}$/;
const IPV4_CIDR_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;
const IPV6_CIDR_RE = /^[0-9a-fA-F:]{2,39}\/(12[0-8]|1[01]\d|[1-9]?\d)$/;

const csv = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Validate the flags into a plan. Throws ValidationError naming the flag. */
export function planRunner(input: RunnerPlanInput): RunnerPlan {
  const label = (input.label ?? 'default').trim().toLowerCase();
  if (!LABEL_RE.test(label)) throw new ValidationError(`--label "${input.label}" must be 1-32 lowercase letters, digits or '-'`, 'label');
  if (!REGION_RE.test(input.region)) throw new ValidationError(`--region "${input.region}" is not an AWS region`, 'region');
  const regions = input.regions ? csv(input.regions) : [input.region];
  if (regions.length === 0) throw new ValidationError('--regions needs at least one region', 'regions');
  for (const r of regions) if (!REGION_RE.test(r)) throw new ValidationError(`--regions: "${r}" is not an AWS region`, 'regions');

  let prefixes: string[] | undefined;
  if (input.pipelinePrefix !== undefined) {
    prefixes = csv(input.pipelinePrefix);
    if (prefixes.length === 0) throw new ValidationError('--pipeline-prefix needs at least one prefix', 'pipeline-prefix');
    if (prefixes.includes('*')) {
      if (!input.yes) {
        throw new ValidationError(
          "--pipeline-prefix '*' lets the runner start and stop EVERY pipeline in the allowed regions — confirm with --yes", 'yes');
      }
      prefixes = ['*'];
    } else {
      for (const p of prefixes) if (!PREFIX_RE.test(p)) throw new ValidationError(`--pipeline-prefix "${p}" is not a valid CodePipeline name prefix`, 'pipeline-prefix');
    }
  }

  const allowIps = input.allowIp ?? [];
  const apiGateway = !!input.apiGateway;
  if (apiGateway && allowIps.length === 0) throw new ValidationError('--api-gateway needs at least one --allow-ip <cidr> (the platform\'s egress IPs)', 'allow-ip');
  if (!apiGateway && allowIps.length > 0) throw new ValidationError('--allow-ip applies only with --api-gateway', 'allow-ip');
  for (const ip of allowIps) if (!IPV4_CIDR_RE.test(ip) && !IPV6_CIDR_RE.test(ip)) throw new ValidationError(`--allow-ip "${ip}" is not a CIDR`, 'allow-ip');

  return {
    label,
    region: input.region,
    regions,
    ...(prefixes ? { prefixes } : {}),
    apiGateway,
    allowIps,
    stackName: runnerStackName(label),
    functionName: runnerFunctionName(label),
    delete: !!input.delete,
    withEvents: !!input.withEvents && !input.delete,
  };
}

/**
 * The org's pipeline-name prefixes, from its registered pipeline names: the
 * `<org>-` segment pipeline-core's defaultPipelineName puts first (that segment
 * never contains '-': non-alphanumerics become '_').
 */
export function prefixesFromPipelineNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const i = n.indexOf('-');
    if (i > 0) out.add(n.slice(0, i + 1));
  }
  return [...out].sort();
}

/** What a dry run prints. No call of any kind is made to build it. */
export function describePlan(plan: RunnerPlan, bundleSha256?: string): Record<string, unknown> {
  const steps = plan.delete
    ? ['revoke the runner on the platform (step-up)', `delete stack ${plan.stackName}`]
    : ['register a pending runner with the platform (step-up)', `deploy stack ${plan.stackName} with its RUNNER_ID`, 'upload the runner handler',
      `read the ${plan.apiGateway ? 'API Gateway' : 'Function URL'} endpoint from the stack (never printed)`,
      'send the endpoint to the platform (step-up); it pings the runner, and a pong makes it active',
      ...(plan.withEvents ? [`run infra setup-events --scoped-ingest in ${plan.region}`] : [])];
  return {
    stackName: plan.stackName,
    label: plan.label,
    region: plan.region,
    regions: plan.regions,
    pipelinePrefixes: plan.prefixes ?? '(derived from your org\'s registered pipeline names at setup)',
    entryPoint: plan.apiGateway ? 'api-gateway' : 'function-url',
    ...(plan.apiGateway ? { allowIps: plan.allowIps } : {}),
    iam: {
      'tag:GetResources': '*',
      [RUNNER_PIPELINE_ACTIONS.join(', ')]: plan.prefixes
        ? pipelineActionResources(plan.regions, plan.prefixes).map((r) => r['Fn::Sub'])
        : '(one ARN per region x derived prefix)',
    },
    ...(bundleSha256 ? { bundleSha256 } : {}),
    steps,
  };
}

// ─── Dependencies (all injectable) ───────────────────────────────────────────

export interface PlatformApi {
  get<T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<T>;
  post<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T>;
  patch<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T>;
  delete<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
}

export interface RunnerDto {
  id: string;
  orgId?: string;
  label: string;
  /** pending (registered, endpoint not yet verified) | active | revoked. */
  status?: RunnerStatus;
  health?: RunnerHealth;
  /** Own org admins only. Compared, never printed. */
  functionUrl?: string | null;
}

export interface SetupRunnerDeps {
  platform: PlatformApi;
  platformBaseUrl: string;
  stepUp: StepUpProvider;
  /** `aws cloudformation deploy` of the given template (written to a temp file). */
  deployStack(a: { stackName: string; template: Record<string, unknown>; parameters: string[]; region: string }): Promise<void>;
  /** The stack's outputs and parameters, or undefined when it does not exist. */
  describeStack(stackName: string, region: string): Promise<{ outputs: Record<string, string>; parameters: Record<string, string> } | undefined>;
  deleteStack(stackName: string, region: string): Promise<void>;
  /** Upload the bundled runner handler and wait until the function is updated. */
  uploadCode(functionName: string, region: string): Promise<void>;
  /** The org's registered pipeline names (for the default prefix). */
  registeredPipelineNames(): Promise<string[]>;
  /** SHA-256 (hex) of the runner bundle this CLI deploys. */
  bundleSha256(): string;
  /** `infra setup-events --scoped-ingest` in the region (--with-events). */
  runSetupEvents(region: string): Promise<void>;
  warn(message: string): void;
}

function unwrap<T>(body: unknown): T {
  const b = body as { data?: T };
  return (b && typeof b === 'object' && b.data !== undefined ? b.data : body) as T;
}

async function stepUpHeaders(deps: SetupRunnerDeps): Promise<Record<string, string>> {
  return { [STEP_UP_HEADER]: await deps.stepUp() };
}

/** The platform's error code / message on a refused request (either envelope). */
function refusal(err: unknown): { status?: number; code?: string; message: string } {
  const e = err as {
    status?: number;
    message?: string;
    response?: { status?: number; data?: { code?: string; errorCode?: string; message?: string; error?: { code?: string; message?: string } } };
  };
  const data = e?.response?.data;
  return {
    status: e?.status ?? e?.response?.status,
    code: data?.error?.code ?? data?.errorCode ?? data?.code,
    message: data?.message ?? data?.error?.message ?? e?.message ?? '',
  };
}

export const RUNNERS_NOT_ENABLED_MESSAGE = 'Cross-account runners are not enabled for your organization — ask your platform operator.';
export const NO_SIGNING_KEY_MESSAGE = 'Cross-account runners are unavailable: this platform has no runner signing key configured (RUNNER_SIGNING_KEY) — ask your platform operator.';

/** Turn the runner-specific refusals into what the operator should do. Anything else is rethrown as-is. */
export function explainRunnerError(err: unknown): never {
  const r = refusal(err);
  const code = r.code as RunnerErrorCode | undefined;
  if (code === 'RUNNER_PING_FAILED' || r.status === RUNNER_ERRORS.RUNNER_PING_FAILED.httpStatus) {
    throw new Error('The platform could not get a pong from the runner at its endpoint (RUNNER_PING_FAILED). The stack is deployed and the runner stays pending: '
      + 'check the runner\'s CloudWatch logs (/aws/lambda/pipeline-builder-runner-<label>) — a wrong PLATFORM_BASE_URL or RUNNER_ID, or an endpoint the platform cannot reach, shows there — '
      + 'then re-run setup-runner to retry. The platform removes a runner still pending after 24 h.');
  }
  if (code === 'RUNNER_PENDING') {
    throw new Error('The runner is still pending: its endpoint has not answered the platform\'s ping yet. Re-run setup-runner to send the endpoint again.');
  }
  // requireFeature's 403 (code INSUFFICIENT_PERMISSIONS) names the flag: `... (cross_account_runners)`.
  if (r.status === 403 && r.message.includes(RUNNER_FEATURE)) {
    throw new Error(RUNNERS_NOT_ENABLED_MESSAGE);
  }
  throw err;
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    return explainRunnerError(err);
  }
}

async function listOwnRunners(deps: SetupRunnerDeps): Promise<RunnerDto[]> {
  const res = unwrap<{ available?: boolean; own?: RunnerDto[] }>(await guarded(() => deps.platform.get(RUNNERS_ROUTE)));
  if (res.available === false) throw new Error(NO_SIGNING_KEY_MESSAGE);
  return res.own ?? [];
}

async function testRunner(deps: SetupRunnerDeps, runnerId: string): Promise<{ ok: boolean; outcome?: RunnerOutcome; errorCode?: string }> {
  try {
    const res = unwrap<{ ok?: boolean; outcome?: RunnerOutcome; errorCode?: string }>(
      await deps.platform.post(`${RUNNERS_ROUTE}/${encodeURIComponent(runnerId)}/test`, {}, await stepUpHeaders(deps)),
    );
    return { ok: !!res.ok, ...(res.outcome ? { outcome: res.outcome } : {}), ...(res.errorCode ? { errorCode: res.errorCode } : {}) };
  } catch (err) {
    return { ok: false, errorCode: refusal(err).code ?? 'TEST_FAILED' };
  }
}

async function resolvePrefixes(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<string[]> {
  if (plan.prefixes) return plan.prefixes;
  const derived = prefixesFromPipelineNames(await deps.registeredPipelineNames());
  if (derived.length === 0) {
    throw new ValidationError(
      'Could not derive a pipeline-name prefix: your org has no registered pipelines yet. Pass --pipeline-prefix <prefix> '
      + "(or --pipeline-prefix '*' --yes for every pipeline).", 'pipeline-prefix');
  }
  return derived;
}

export interface SetupRunnerResult {
  action: 'created' | 'updated' | 'deleted';
  runnerId?: string;
  label: string;
  stackName: string;
  region: string;
  regions: string[];
  prefixes?: string[];
  /** pending | active, as the platform last reported it. */
  status?: string;
  test?: { ok: boolean; outcome?: RunnerOutcome; errorCode?: string };
  bundleSha256?: string;
  eventsStack?: 'present' | 'missing' | 'deployed';
}

/**
 * Which runner this stack is: the one it already names, else a pending one left
 * by an interrupted install of this label, else a new pending runner (step-up).
 */
async function bindRunner(plan: RunnerPlan, deps: SetupRunnerDeps, own: RunnerDto[]): Promise<{ runner: RunnerDto; action: 'created' | 'updated' }> {
  const existing = await deps.describeStack(plan.stackName, plan.region);
  const boundId = existing?.parameters.RunnerId || undefined;
  if (boundId) {
    const runner = own.find((r) => r.id === boundId);
    if (!runner || runner.status === 'revoked') {
      throw new ValidationError(
        `Stack ${plan.stackName} belongs to runner ${boundId}, which the platform no longer has (revoked, or a pending runner older than 24 h). `
        + `Remove it with "pipeline-manager infra setup-runner --label ${plan.label} --region ${plan.region} --delete", then install again.`, 'label');
    }
    return { runner, action: 'updated' };
  }
  const pending = own.find((r) => r.label === plan.label && r.status === 'pending');
  if (pending) return { runner: pending, action: 'updated' };
  const created = unwrap<{ runner?: RunnerDto }>(await guarded(async () => deps.platform.post(
    RUNNERS_ROUTE, { label: plan.label, regions: plan.regions }, await stepUpHeaders(deps),
  )));
  if (!created.runner?.id) throw new Error('The platform registered the runner but returned no runner id');
  return { runner: created.runner, action: 'created' };
}

/**
 * A pending runner, or one whose endpoint changed, gets the endpoint PATCHed
 * (the platform checks the host and pings it, aud = its id; a pong activates
 * it). An active one with the same endpoint gets a test ping.
 */
async function activateOrTest(deps: SetupRunnerDeps, runner: RunnerDto, functionUrl: string): Promise<Pick<SetupRunnerResult, 'status' | 'test'>> {
  if (runner.status === 'active' && (!runner.functionUrl || runner.functionUrl === functionUrl)) {
    return { ...(runner.status ? { status: runner.status } : {}), test: await testRunner(deps, runner.id) };
  }
  const patched = unwrap<{ runner?: RunnerDto }>(await guarded(async () => deps.platform.patch(
    `${RUNNERS_ROUTE}/${encodeURIComponent(runner.id)}`, { functionUrl }, await stepUpHeaders(deps),
  )));
  return { status: patched.runner?.status ?? 'active' };
}

/** Event reporting in the stack region: present, deployed now (--with-events), or missing (warned). */
async function ensureEventReporting(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<NonNullable<SetupRunnerResult['eventsStack']>> {
  const present = !!(await deps.describeStack(EVENTS_STACK_NAME, plan.region));
  if (plan.withEvents) {
    await deps.runSetupEvents(plan.region);
    return 'deployed';
  }
  if (present) return 'present';
  deps.warn(`No ${EVENTS_STACK_NAME} stack in ${plan.region}: runs started through this runner will show as started, but their progress and outcome `
    + 'will not reach the platform. Add --with-events (or run "pipeline-manager infra setup-events --scoped-ingest").');
  return 'missing';
}

/** Install or update a runner. */
export async function setupRunnerFlow(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<SetupRunnerResult> {
  // First call: a feature refusal or a missing signing key stops here, before anything is created in AWS.
  const own = await listOwnRunners(deps);
  const prefixes = await resolvePrefixes(plan, deps);
  const bundleSha256 = deps.bundleSha256();
  const template = buildRunnerTemplate({ regions: plan.regions, prefixes, apiGateway: plan.apiGateway, allowIps: plan.allowIps });
  const { runner, action } = await bindRunner(plan, deps, own);

  // ONE deploy, already bound: the runner accepts only requests addressed to runner.id.
  await deps.deployStack({
    stackName: plan.stackName,
    template,
    parameters: runnerStackParameters({
      regions: plan.regions,
      prefixes,
      apiGateway: plan.apiGateway,
      allowIps: plan.allowIps,
      runnerId: runner.id,
      platformBaseUrl: deps.platformBaseUrl,
      label: plan.label,
      version: APP_VERSION,
    }),
    region: plan.region,
  });
  await deps.uploadCode(plan.functionName, plan.region);

  const functionUrl = (await deps.describeStack(plan.stackName, plan.region))?.outputs.EndpointUrl;
  if (!functionUrl) throw new Error(`Stack ${plan.stackName} has no EndpointUrl output`);
  const { status, test } = await activateOrTest(deps, runner, functionUrl);
  const eventsStack = await ensureEventReporting(plan, deps);

  return {
    action,
    runnerId: runner.id,
    label: plan.label,
    stackName: plan.stackName,
    region: plan.region,
    regions: plan.regions,
    prefixes,
    ...(status ? { status } : {}),
    ...(test ? { test } : {}),
    bundleSha256,
    eventsStack,
  };
}

/**
 * Revoke on the platform, THEN delete the stack. The runner is the one the
 * stack here names; without a stack, only a PENDING runner of that label (an
 * install that never got this far) is revoked by label — an active one lives in
 * a stack somewhere else (labels are not unique across accounts and regions),
 * and revoking it from the wrong account would silently cut that one off.
 */
export async function deleteRunner(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<SetupRunnerResult> {
  const stack = await deps.describeStack(plan.stackName, plan.region);
  let runnerId = stack?.parameters.RunnerId || undefined;
  if (!runnerId) {
    const byLabel = (await listOwnRunners(deps)).filter((r) => r.label === plan.label && r.status !== 'revoked');
    runnerId = byLabel.find((r) => r.status === 'pending')?.id;
    if (!runnerId && !stack && byLabel.length > 0) {
      throw new ValidationError(
        `Runner "${plan.label}" is active, but there is no stack ${plan.stackName} in ${plan.region} with these AWS credentials: it is installed in another AWS account or region. `
        + 'Re-run --delete there (--region / --profile), or revoke it under Settings → Organization → Pipeline runners.', 'label');
    }
  }
  if (!stack && !runnerId) throw new ValidationError(`No runner "${plan.label}" found (no stack ${plan.stackName} in ${plan.region}, no platform runner with that label)`, 'label');

  if (runnerId) {
    try {
      await deps.platform.delete(`${RUNNERS_ROUTE}/${encodeURIComponent(runnerId)}`, await stepUpHeaders(deps));
    } catch (err) {
      // Never delete the stack of a runner the platform still has.
      if (refusal(err).status !== 404) explainRunnerError(err);
      deps.warn('The platform has no such runner any more — removing the stack only');
    }
  }
  if (stack) await deps.deleteStack(plan.stackName, plan.region);
  return { action: 'deleted', ...(runnerId ? { runnerId } : {}), label: plan.label, stackName: plan.stackName, region: plan.region, regions: plan.regions };
}

// ─── Real dependencies ───────────────────────────────────────────────────────

/** The bundled handler `uploadCode` ships (dist/lambda/runner-handler.js once built). */
function runnerBundlePath(): string {
  return path.join(__dirname, '../lambda/runner-handler.js');
}

/** SHA-256 of the runner bundle: what release notes list, so an operator can check what runs in their account. */
export function sha256OfFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

type RealDeps = 'deployStack' | 'describeStack' | 'deleteStack' | 'uploadCode' | 'bundleSha256' | 'runSetupEvents' | 'warn';

function realAwsDeps(profile: string | undefined): Pick<SetupRunnerDeps, RealDeps> {
  return {
    bundleSha256: () => sha256OfFile(runnerBundlePath()),
    async runSetupEvents(region) {
      // The existing command, exactly as an operator would run it (same CLI build).
      const args = [process.argv[1]!, 'infra', 'setup-events', '--scoped-ingest', '--region', region, ...(profile ? ['--profile', profile] : [])];
      execFileSync(process.execPath, args, { stdio: ['inherit', 2, 2] });
    },
    warn: (m) => printWarning(m),
    async deployStack({ stackName, template, parameters, region }) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-stack-'));
      try {
        const file = path.join(tmp, 'runner-stack.json');
        fs.writeFileSync(file, JSON.stringify(template));
        const args = ['cloudformation', 'deploy', '--stack-name', stackName, '--template-file', file,
          '--parameter-overrides', ...parameters, '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--region', region];
        if (profile) args.push('--profile', profile);
        // Progress to stderr: stdout stays clean for --json (and never carries outputs).
        execFileSync('aws', args, { stdio: ['ignore', 2, 2] });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    async describeStack(stackName, region) {
      const cfn = new CloudFormationClient({ region });
      try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
        const s = out.Stacks?.[0];
        if (!s) return undefined;
        return {
          outputs: Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? ''])),
          parameters: Object.fromEntries((s.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? ''])),
        };
      } catch (err) {
        if (/does not exist/i.test((err as Error)?.message ?? '')) return undefined;
        throw err;
      }
    },
    async deleteStack(stackName, region) {
      const cfn = new CloudFormationClient({ region });
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
      await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 900 }, { StackName: stackName });
    },
    async uploadCode(functionName, region) {
      const handlerSrc = runnerBundlePath();
      if (!fs.existsSync(handlerSrc)) throw new Error(`Runner handler not found at ${handlerSrc} — was the package built?`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-code-'));
      try {
        // ESM bundle: the zip entry must be index.mjs (Handler stays index.handler).
        fs.copyFileSync(handlerSrc, path.join(tmp, 'index.mjs'));
        const zipPath = path.join(tmp, 'index.zip');
        execFileSync('zip', ['-j', zipPath, 'index.mjs'], { cwd: tmp, stdio: 'pipe' });
        const lambda = new LambdaClient({ region });
        await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: fs.readFileSync(zipPath) }));
        // A following stack update would conflict with an in-progress code update.
        await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 300 }, { FunctionName: functionName });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

function printResult(r: SetupRunnerResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ success: true, ...r }, null, 2));
    return;
  }
  console.log('');
  printSection(r.action === 'deleted' ? 'Runner Removed' : 'Runner Ready');
  printKeyValue({
    'Runner Id': r.runnerId ?? '(none)',
    'Label': r.label,
    'Stack': r.stackName,
    'Region': r.region,
    ...(r.action !== 'deleted' ? { 'Acts In': r.regions.join(', '), 'Pipeline Prefixes': (r.prefixes ?? []).join(', ') } : {}),
    ...(r.test ? { 'Test Ping': r.test.ok ? `✓ ${r.test.outcome ?? 'pong'}` : `✗ ${r.test.errorCode ?? 'failed'}` } : {}),
    ...(r.status ? { Status: r.status } : {}),
    ...(r.bundleSha256 ? { 'Bundle SHA-256': r.bundleSha256 } : {}),
    ...(r.eventsStack ? { 'Event Reporting': r.eventsStack === 'missing' ? 'not set up in this region' : '✓' } : {}),
  });
  if (r.test && !r.test.ok) printWarning('The test ping failed — check the runner\'s CloudWatch logs, then retest from Settings → Organization → Pipeline runners.');
  if (r.action !== 'deleted') printSuccess(`Runner ${r.action}. Remove it with: pipeline-manager infra setup-runner --label ${r.label} --region ${r.region} --delete`);
}

/**
 * Registers `infra setup-runner`.
 *
 * @example
 * ```bash
 * pipeline-manager infra setup-runner --region us-east-1 --regions us-east-1,eu-west-2 --pipeline-prefix acme-
 * pipeline-manager infra setup-runner --region us-east-1 --api-gateway --allow-ip 203.0.113.10/32
 * pipeline-manager infra setup-runner --region us-east-1 --label ops --delete
 * pipeline-manager infra setup-runner --region us-east-1 --dry-run --json
 * ```
 */
export function setupRunner(program: Command): void {
  withSslOptions(withProfileOption(program
    .command('setup-runner')
    .description('Install a cross-account pipeline runner in this AWS account (the platform pushes signed run requests to it), or remove it with --delete')
    .option('--region <region>', 'Region for the runner stack (default: AWS_REGION / the profile\'s region)')
    .option('--regions <csv>', 'Regions the runner may act in (default: the stack region)')
    .option('--pipeline-prefix <csv>', "CodePipeline name prefixes the runner may act on (default: your org's prefix from its registered pipelines; '*' = all, needs --yes)")
    .option('--label <label>', 'Runner label (stack pipeline-builder-runner-<label>)', 'default')
    .option('--api-gateway', 'Front the runner with an API Gateway restricted to --allow-ip instead of a Function URL', false)
    .option('--allow-ip <cidr...>', 'With --api-gateway: the platform egress CIDRs the API admits')
    .option('-p, --password <password>', 'Password for the step-up the runner writes require (prefer PLATFORM_PASSWORD)')
    .option('--step-up <method>', 'auto, password, totp or browser', 'auto')
    .option('--no-browser', 'With browser step-up: print the approval URL instead of opening a browser')
    .option('--with-events', 'Afterwards run "infra setup-events --scoped-ingest" in the region, so runner-started executions report their progress', false)
    .option('--delete', 'Revoke the runner on the platform, then delete its stack', false)
    .option('-y, --yes', "Confirm --pipeline-prefix '*'", false)
    .option('--dry-run', 'Show what would be deployed without calling AWS or the platform', false)
    .option('--json', 'Output result as JSON', false)))
    .action(async (options) => {
      const executionId = printCommandHeader('Setup Runner', undefined, { quiet: options.json });
      if (options.json) setMachineOutput(true);
      try {
        printSslWarning(options.verifySsl);
        // Dry run: no AWS call, not even the profile-region lookup.
        const region = options.region || (options.dryRun ? (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1') : await resolveDeployRegion(undefined, options.profile));
        const plan = planRunner({
          label: options.label,
          region,
          regions: options.regions,
          pipelinePrefix: options.pipelinePrefix,
          apiGateway: options.apiGateway,
          allowIp: options.allowIp,
          yes: options.yes,
          delete: options.delete,
          withEvents: options.withEvents,
        });

        if (options.dryRun) {
          // Reading the local bundle is not a call: the dry run still touches neither AWS nor the platform.
          const bundle = runnerBundlePath();
          const d = describePlan(plan, fs.existsSync(bundle) ? sha256OfFile(bundle) : undefined);
          if (options.json) {console.log(JSON.stringify({ success: true, dryRun: true, ...d }, null, 2));} else {
            printSection('Dry Run — No Changes Made');
            printInfo('Plan', d);
          }
          return;
        }

        applyAwsProfile(options.profile);
        await ensurePlatformToken(options);
        const password = (options.password as string | undefined) || process.env.PLATFORM_PASSWORD;
        const method = chooseStepUp({ requested: options.stepUp, password, interactive: !!process.stdin.isTTY && !options.json });
        const client = await createAuthenticatedClientAsync(options);
        const deps: SetupRunnerDeps = {
          ...realAwsDeps(options.profile),
          platform: client,
          platformBaseUrl: client.getBaseUrl() || getApiConfig().api.baseUrl,
          stepUp: buildStepUpProvider(method, client, {
            password, verifySsl: options.verifySsl, browser: options.browser, purpose: `${plan.delete ? 'remove' : 'register'} the '${plan.label}' pipeline runner`,
          }),
          async registeredPipelineNames() {
            const names: string[] = [];
            for (let offset = 0; ;) {
              const page = extractListPage<{ pipelineName?: string }>(await client.get(`${client.getConfig().api.pipelineUrl}/registry`, { limit: 500, offset }), 'registry');
              names.push(...page.items.map((r) => r.pipelineName ?? '').filter(Boolean));
              offset += page.items.length;
              if (!page.hasMore || page.items.length === 0) return names;
            }
          },
        };

        const result = plan.delete ? await deleteRunner(plan, deps) : await setupRunnerFlow(plan, deps);
        auditLog('setup-runner', { executionId, action: result.action, runnerId: result.runnerId ?? null, label: plan.label, region: plan.region });
        printResult(result, !!options.json);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, { exit: true, context: { command: 'setup-runner', executionId, label: options.label } });
      }
    });
}
