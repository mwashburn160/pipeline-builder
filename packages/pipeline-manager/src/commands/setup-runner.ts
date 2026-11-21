// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra setup-runner` — install (or update, or remove) a CROSS-ACCOUNT
 * PIPELINE RUNNER in the AWS account the operator's credentials point at.
 *
 * The runner is a Lambda (src/lambda/runner-handler.ts) that starts and stops
 * this account's pipelines with its own role, on requests the platform SIGNS
 * with the owning organization's runner signing key and POSTs to its endpoint.
 * The runner verifies them against its own key set,
 * `<platform>/api/pipelines/runner/runners/<runnerId>/jwks.json`. The platform
 * never gets AWS access, a role ARN or this account's number, and the runner
 * holds no platform credential.
 *
 * ONE RUNNER PER AWS ACCOUNT PER ORGANIZATION. One runner covers every region
 * in its --regions, so an organization never needs a second one in an account.
 * Before anything is created, the account's runner stacks
 * (`pipeline-builder-runner-*` in EVERY enabled region of the account — EC2
 * DescribeRegions, opt-in regions not opted into excluded — read in parallel)
 * are listed and each one's RunnerId is checked against the org's runner list:
 *   - the org's own runner with this --label: update it in place;
 *   - the org's own runner with another label: refused (update that one);
 *   - a parent organization's shared runner: warned (the team already reaches
 *     this account through it) and confirmed (--yes skips the question);
 *   - anyone else's: allowed, with a warning that a shared AWS account is a
 *     shared trust boundary and that each org should use distinct
 *     ALLOWED_PIPELINE_PREFIXES (--pipeline-prefix).
 *
 *   install: register a PENDING runner (step-up) → deploy the stack
 *     `pipeline-builder-runner-<runnerId>` ONCE with its RUNNER_ID (the label is
 *     the stack tag pb.runner-label) → upload the handler → read the endpoint
 *     (Function URL, or the IP-allowlisted API Gateway) from the stack outputs →
 *     PATCH it onto the runner (step-up). The platform then sends a signed ping
 *     addressed to that id; a `pong` makes the runner active.
 *   signing key: a root org's key is created with its first runner. An org with
 *     no effective key is refused before anything is deployed, unless
 *     --generate-key creates one (step-up); an org that inherits its key from a
 *     parent with none is told to ask that parent.
 *   update (the account has this org's runner with this label): redeploy +
 *     upload in place; a still-pending runner, or one whose endpoint changed,
 *     gets the URL PATCHed; an active one is test-pinged.
 *   --delete: revoke on the platform FIRST (step-up), then delete the stack.
 *   --with-events: afterwards run `infra setup-events --scoped-ingest`, so
 *     executions started through the runner report their status.
 *
 * The endpoint URL is a secret: it is sent to the platform and never printed.
 */

import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import * as os from 'os';
import path from 'path';
import {
  CloudFormationClient, DeleteStackCommand, DescribeStacksCommand, ListStacksCommand, type Stack, type StackStatus,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { LambdaClient, UpdateFunctionCodeCommand, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import {
  RUNNER_ERRORS, runnerJwksPath, type RunnerErrorCode, type RunnerHealth, type RunnerOutcome, type RunnerSigningKeyDto,
  type RunnersUnavailableReason, type RunnerStatus,
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
import { apiRefusal, extractListPage, unwrapData } from '../utils/response-utils.js';
import {
  buildRunnerTemplate, DEFAULT_WAF_RATE_LIMIT, pipelineActionResources, RUNNER_LABEL_TAG, RUNNER_PIPELINE_ACTIONS, RUNNER_STACK_PREFIX,
  runnerFunctionName, runnerStackName, runnerStackParameters, WAF_RATE_LIMIT_MAX, WAF_RATE_LIMIT_MIN,
} from '../utils/runner-template.js';
import { STEP_UP_HEADER, type StepUpProvider } from '../utils/service-account.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUNNERS_ROUTE = '/api/pipelines/runners';
const SIGNING_KEY_ROUTE = `${RUNNERS_ROUTE}/signing-key`;
const RUNNERS_PANEL = 'Settings → Organization → Pipeline runners';

// ─── Plan (pure, offline) ────────────────────────────────────────────────────

export interface RunnerPlanInput {
  label?: string;
  region: string;
  regions?: string;
  pipelinePrefix?: string;
  apiGateway?: boolean;
  allowIp?: string[];
  /** commander's `--no-waf` (true unless given). */
  waf?: boolean;
  /** `--waf-rate-limit <n>` as typed. */
  wafRateLimit?: string | number;
  /** `--generate-key`: create the org's signing key (step-up) when it has none. */
  generateKey?: boolean;
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
  /**
   * The regions the account scan MUST cover (the stack region, then every
   * --regions region): listed first, and an unreadable one fails the scan. The
   * scan itself covers every enabled region of the account ({@link accountRunnerStacks}).
   */
  scanRegions: string[];
  /** Explicit prefixes, or undefined = derive from the org's registered pipeline names. */
  prefixes?: string[];
  apiGateway: boolean;
  allowIps: string[];
  /** The API's WAFv2 rate limit is attached (api-gateway only). */
  waf: boolean;
  /** Requests per 5 minutes per source IP (meaningful when `waf`). */
  wafRateLimit: number;
  generateKey: boolean;
  /** --yes: confirms '*' prefixes and installing beside a parent organization's shared runner. */
  yes: boolean;
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

  const wafWanted = input.waf !== false;
  let wafRateLimit = DEFAULT_WAF_RATE_LIMIT;
  if (input.wafRateLimit !== undefined) {
    if (!apiGateway) throw new ValidationError('--waf-rate-limit applies only with --api-gateway (a Function URL has no WAF)', 'waf-rate-limit');
    if (!wafWanted) throw new ValidationError('--waf-rate-limit and --no-waf contradict each other', 'waf-rate-limit');
    const raw = String(input.wafRateLimit).trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < WAF_RATE_LIMIT_MIN || n > WAF_RATE_LIMIT_MAX) {
      throw new ValidationError(`--waf-rate-limit "${input.wafRateLimit}" must be a whole number of requests per 5 minutes per IP, ${WAF_RATE_LIMIT_MIN}-${WAF_RATE_LIMIT_MAX}`, 'waf-rate-limit');
    }
    wafRateLimit = n;
  }
  if (input.generateKey && input.delete) throw new ValidationError('--generate-key and --delete contradict each other', 'generate-key');

  return {
    label,
    region: input.region,
    regions,
    scanRegions: [...new Set([input.region, ...regions])],
    ...(prefixes ? { prefixes } : {}),
    apiGateway,
    allowIps,
    waf: apiGateway && wafWanted,
    wafRateLimit,
    generateKey: !!input.generateKey,
    yes: !!input.yes,
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

/** The stack name and JWKS path before the runner id is known (dry run, help). */
const STACK_NAME_PATTERN = runnerStackName('<runnerId>');
const JWKS_PATH_PATTERN = runnerJwksPath('RUNNER_ID').replace('RUNNER_ID', '<runnerId>');

/** Where the account scan looks, as the dry run says it. */
const scanScope = (plan: RunnerPlan): string =>
  `every enabled region of the account (EC2 DescribeRegions; ${plan.scanRegions.join(', ')} always)`;

/** What a dry run prints. No call of any kind is made to build it. */
export function describePlan(plan: RunnerPlan, bundleSha256?: string): Record<string, unknown> {
  const steps = plan.delete
    ? [`find this organization's runner "${plan.label}" among the account's runner stacks in ${scanScope(plan)}`,
      'revoke the runner on the platform (step-up)', 'delete its stack']
    : [`list the account's runner stacks in ${scanScope(plan)}: one runner per AWS account per organization`,
      ...(plan.generateKey ? ['generate the organization\'s runner signing key if it has none (step-up)'] : []),
      'register a pending runner with the platform (step-up)', `deploy stack ${STACK_NAME_PATTERN} with its RUNNER_ID`, 'upload the runner handler',
      `read the ${plan.apiGateway ? 'API Gateway' : 'Function URL'} endpoint from the stack (never printed)`,
      'send the endpoint to the platform (step-up); it pings the runner, and a pong makes it active',
      ...(plan.withEvents ? [`run infra setup-events --scoped-ingest in ${plan.region}`] : [])];
  return {
    stackName: STACK_NAME_PATTERN,
    stackTags: { [RUNNER_LABEL_TAG]: plan.label },
    label: plan.label,
    region: plan.region,
    regions: plan.regions,
    pipelinePrefixes: plan.prefixes ?? '(derived from your org\'s registered pipeline names at setup)',
    entryPoint: plan.apiGateway ? 'api-gateway' : 'function-url',
    ...(plan.apiGateway ? { allowIps: plan.allowIps } : {}),
    ...(plan.apiGateway ? { waf: plan.waf ? { rateLimit: plan.wafRateLimit, per: '5 minutes per source IP', action: 'block' } : 'disabled (--no-waf)' } : {}),
    iam: {
      'tag:GetResources': '*',
      [RUNNER_PIPELINE_ACTIONS.join(', ')]: plan.prefixes
        ? pipelineActionResources(plan.regions, plan.prefixes).map((r) => r['Fn::Sub'])
        : '(one ARN per region x derived prefix)',
    },
    jwksUrl: `<platform>${JWKS_PATH_PATTERN}`,
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

/** A parent organization's runner shared with this team (`inherited` on the runner list). */
export interface InheritedRunnerDto extends RunnerDto {
  fromOrgId?: string;
  fromOrgName?: string;
}

/** What `GET /pipelines/runners` tells setup-runner. */
export interface RunnerList {
  own: RunnerDto[];
  inherited: InheritedRunnerDto[];
  signingKey: RunnerSigningKeyDto | null;
}

/** One `pipeline-builder-runner-*` stack in the account (read with the operator's credentials, never sent to the platform). */
export interface RunnerStackInfo {
  stackName: string;
  region: string;
  /** Its RunnerId parameter (the function's RUNNER_ID). */
  runnerId?: string;
  /** Its pb.runner-label tag. */
  label?: string;
  /** Its AllowedPipelinePrefixes parameter. */
  prefixes: string[];
}

export interface SetupRunnerDeps {
  platform: PlatformApi;
  platformBaseUrl: string;
  stepUp: StepUpProvider;
  /** `aws cloudformation deploy` of the given template (written to a temp file). */
  deployStack(a: { stackName: string; template: Record<string, unknown>; parameters: string[]; tags: Record<string, string>; region: string }): Promise<void>;
  /** The stack's outputs and parameters, or undefined when it does not exist. */
  describeStack(stackName: string, region: string): Promise<{ outputs: Record<string, string>; parameters: Record<string, string> } | undefined>;
  /** The account's enabled regions (EC2 DescribeRegions, AllRegions=false), asked in `region`. */
  enabledRegions(region: string): Promise<string[]>;
  /**
   * Every runner stack (`pipeline-builder-runner-*`) in these regions of the
   * account. An unreadable region in `required` fails the call; any other is
   * warned about and skipped (an SCP that denies a region denies a runner there too).
   */
  listRunnerStacks(regions: string[], required: string[]): Promise<RunnerStackInfo[]>;
  deleteStack(stackName: string, region: string): Promise<void>;
  /** Upload the bundled runner handler and wait until the function is updated. */
  uploadCode(functionName: string, region: string): Promise<void>;
  /** The org's registered pipeline names (for the default prefix). */
  registeredPipelineNames(): Promise<string[]>;
  /** SHA-256 (hex) of the runner bundle this CLI deploys. */
  bundleSha256(): string;
  /** `infra setup-events --scoped-ingest` in the region (--with-events). */
  runSetupEvents(region: string): Promise<void>;
  /** A y/N question; false when nobody can answer (not a terminal, --json). */
  confirm(question: string): Promise<boolean>;
  warn(message: string): void;
}

async function stepUpHeaders(deps: SetupRunnerDeps): Promise<Record<string, string>> {
  return { [STEP_UP_HEADER]: await deps.stepUp() };
}

/** Why the platform cannot take runners right now (`available: false` / 409 RUNNERS_UNAVAILABLE), by reason. */
const RUNNERS_UNAVAILABLE_MESSAGES = {
  paused: 'Pipeline runs through runners are paused on this platform by its operator. Try again once they are resumed.',
  encryption_not_configured: 'Runners are unavailable: this platform has no secret encryption configured for runner signing keys — ask your platform operator.',
  key_service: 'Runs can\'t be signed right now because the key service is unreachable. Queued runs retry automatically.',
} as const satisfies Record<RunnersUnavailableReason, string>;

/** Why the platform cannot take runners right now (`available: false` / 409 RUNNERS_UNAVAILABLE). */
export function runnersUnavailableMessage(reason?: RunnersUnavailableReason | null): string {
  return reason && Object.hasOwn(RUNNERS_UNAVAILABLE_MESSAGES, reason)
    ? RUNNERS_UNAVAILABLE_MESSAGES[reason]
    : 'Runners are unavailable on this platform right now — ask your platform operator.';
}

/** A 409 RUNNERS_UNAVAILABLE refusal's `details.reason`, when the server sent one. */
export function refusalUnavailableReason(err: unknown): RunnersUnavailableReason | null {
  const reason = (err as { response?: { data?: { details?: { reason?: unknown } } } } | null)?.response?.data?.details?.reason;
  return typeof reason === 'string' && Object.hasOwn(RUNNERS_UNAVAILABLE_MESSAGES, reason) ? reason as RunnersUnavailableReason : null;
}

/** The org has no effective signing key and none will be created by this run. */
export const NO_ORG_KEY_MESSAGE = 'Your organization has no runner signing key yet, so the platform cannot sign requests to a runner. '
  + `Re-run with --generate-key, or generate one under ${RUNNERS_PANEL} (Signing key), then run setup-runner again.`;

export const KEY_UNREADABLE_MESSAGE = 'Your organization\'s runner signing key can\'t be read, so runs through your runners are paused until your platform operator fixes it (RUNNER_KEY_UNREADABLE).';

/** A team that inherits its key from a parent with no key: only that parent (or switching to its own key) can fix it. */
export function inheritedNoKeyMessage(parentName: string | undefined): string {
  return `Your organization uses the runner signing key of ${parentName ? `"${parentName}"` : 'its parent organization'}, which has no key yet. `
    + `Ask that organization's admins to generate one, or switch to your own key (Use our own key) under ${RUNNERS_PANEL}.`;
}

/** What the operator should do about each runner-specific refusal setup-runner can meet. */
const RUNNER_REFUSALS = {
  RUNNER_PING_FAILED: 'The platform could not get a pong from the runner at its endpoint (RUNNER_PING_FAILED). The stack is deployed and the runner stays pending: '
    + 'check the runner\'s CloudWatch logs (/aws/lambda/pipeline-builder-runner-<runnerId>) — a wrong PLATFORM_BASE_URL or RUNNER_ID, or an endpoint the platform cannot reach, shows there — '
    + 'then re-run setup-runner to retry. The platform removes a runner still pending after 24 h.',
  RUNNER_PENDING: 'The runner is still pending: its endpoint has not answered the platform\'s ping yet. Re-run setup-runner to send the endpoint again.',
  RUNNER_KEY_MISSING: NO_ORG_KEY_MESSAGE,
  RUNNER_KEY_UNREADABLE: KEY_UNREADABLE_MESSAGE,
  RUNNER_KEY_INHERITED: inheritedNoKeyMessage(undefined),
  RUNNERS_UNAVAILABLE: runnersUnavailableMessage(null),
} as const satisfies Partial<Record<RunnerErrorCode, string>>;

/** Turn the runner-specific refusals into what the operator should do. Anything else is rethrown as-is. */
export function explainRunnerError(err: unknown): never {
  const r = apiRefusal(err);
  // A 422 without a code is the ping failure too (the only 422 on these routes).
  const code = r.code && Object.hasOwn(RUNNER_REFUSALS, r.code)
    ? r.code as keyof typeof RUNNER_REFUSALS
    : r.status === RUNNER_ERRORS.RUNNER_PING_FAILED.httpStatus ? 'RUNNER_PING_FAILED' : undefined;
  if (code === 'RUNNERS_UNAVAILABLE') throw new Error(runnersUnavailableMessage(refusalUnavailableReason(err)));
  if (code) throw new Error(RUNNER_REFUSALS[code]);
  throw err;
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    return explainRunnerError(err);
  }
}

async function listRunners(deps: SetupRunnerDeps): Promise<RunnerList> {
  const res = unwrapData<{ available?: boolean; unavailableReason?: RunnersUnavailableReason | null; own?: RunnerDto[]; inherited?: InheritedRunnerDto[]; signingKey?: RunnerSigningKeyDto | null }>(
    await guarded(() => deps.platform.get(RUNNERS_ROUTE)),
  );
  if (res.available === false) throw new Error(runnersUnavailableMessage(res.unavailableReason));
  return { own: res.own ?? [], inherited: res.inherited ?? [], signingKey: res.signingKey ?? null };
}

async function testRunner(deps: SetupRunnerDeps, runnerId: string): Promise<{ ok: boolean; outcome?: RunnerOutcome; errorCode?: string }> {
  try {
    const res = unwrapData<{ ok?: boolean; outcome?: RunnerOutcome; errorCode?: string }>(
      await deps.platform.post(`${RUNNERS_ROUTE}/${encodeURIComponent(runnerId)}/test`, {}, await stepUpHeaders(deps)),
    );
    return { ok: !!res.ok, ...(res.outcome ? { outcome: res.outcome } : {}), ...(res.errorCode ? { errorCode: res.errorCode } : {}) };
  } catch (err) {
    return { ok: false, errorCode: apiRefusal(err).code ?? 'TEST_FAILED' };
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

/** Where the org's signing key came from on this run. Key ids only. */
export interface SigningKeyStatus {
  /** existing: the org (own mode) has one; inherited: a parent's; generated: --generate-key now; with-first-runner: the platform creates it on registration. */
  origin: 'existing' | 'inherited' | 'generated' | 'with-first-runner';
  kid: string | null;
  inheritedFrom?: string;
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
  /** The runner's own key set: what it verifies every request against. */
  jwksUrl?: string;
  signingKey?: SigningKeyStatus;
  bundleSha256?: string;
  eventsStack?: 'present' | 'missing' | 'deployed';
}

// ─── One runner per AWS account per organization ─────────────────────────────

/** The account's runner stacks, sorted by whose runner each one is. */
export interface AccountRunners {
  /** This org's runners (RunnerId is in its own list). */
  own: Array<{ stack: RunnerStackInfo; runner: RunnerDto }>;
  /** A parent organization's runners shared with this org. */
  inherited: Array<{ stack: RunnerStackInfo; runner: InheritedRunnerDto }>;
  /** Anyone else's (another organization's, or a stale stack of a revoked runner). */
  foreign: RunnerStackInfo[];
}

/** Sort the account's runner stacks by reading each RunnerId against the org's runner list. */
export function classifyAccountRunners(stacks: RunnerStackInfo[], list: RunnerList): AccountRunners {
  const out: AccountRunners = { own: [], inherited: [], foreign: [] };
  for (const stack of stacks) {
    const own = stack.runnerId ? list.own.find((r) => r.id === stack.runnerId) : undefined;
    if (own) { out.own.push({ stack, runner: own }); continue; }
    const inherited = stack.runnerId ? list.inherited.find((r) => r.id === stack.runnerId) : undefined;
    if (inherited) { out.inherited.push({ stack, runner: inherited }); continue; }
    out.foreign.push(stack);
  }
  return out;
}

/** Two prefix sets can name the same pipeline ('*' overlaps everything; 'acme-' overlaps 'acme-web-'). */
export function prefixesOverlap(a: string[], b: string[]): boolean {
  if (a.includes('*') || b.includes('*')) return a.length > 0 && b.length > 0;
  return a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));
}

const where = (s: RunnerStackInfo): string => `stack ${s.stackName} in ${s.region}`;

/**
 * The account's runner stacks in EVERY enabled region: the rule is one runner
 * per account, and a runner stack in a region outside the stack region and
 * --regions is still in the account. The stack region and --regions come first
 * and must be readable; the rest follow in the order DescribeRegions answers.
 * Returns the stacks and the regions scanned.
 */
export async function accountRunnerStacks(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<{ stacks: RunnerStackInfo[]; regions: string[] }> {
  let enabled: string[];
  try {
    enabled = await deps.enabledRegions(plan.region);
  } catch (err) {
    throw new ValidationError(
      'Could not list this AWS account\'s enabled regions (ec2:DescribeRegions), so the one-runner-per-account check cannot cover the account: '
      + `${err instanceof Error ? err.message : String(err)}. Grant ec2:DescribeRegions to these credentials, then re-run.`, 'region');
  }
  const regions = [...new Set([...plan.scanRegions, ...enabled])];
  return { stacks: await deps.listRunnerStacks(regions, plan.scanRegions), regions };
}

/**
 * Read each region's runner stacks IN PARALLEL with `listOne`, in `regions`
 * order. A failed region in `required` fails the scan (naming it); any other
 * failed region is warned about and skipped.
 */
export async function scanRegionStacks(
  regions: string[],
  required: string[],
  listOne: (region: string) => Promise<RunnerStackInfo[]>,
  warn: (message: string) => void,
): Promise<RunnerStackInfo[]> {
  const settled = await Promise.allSettled(regions.map((r) => listOne(r)));
  const out: RunnerStackInfo[] = [];
  settled.forEach((res, i) => {
    const region = regions[i]!;
    if (res.status === 'fulfilled') { out.push(...res.value); return; }
    const why = res.reason instanceof Error ? res.reason.message : String(res.reason);
    if (required.includes(region)) {
      throw new ValidationError(`Could not list the runner stacks in ${region}: ${why}`, 'region');
    }
    warn(`Could not list the runner stacks in ${region} (${why}); the one-runner-per-account check skipped that region.`);
  });
  return out;
}

/**
 * Enforce the rule against what is in the account, before anything is created:
 * the runner to update (this org's, same label), or nothing (install a new one).
 * Refuses a second runner of this org; warns about other orgs' runners and asks
 * before installing beside a parent organization's shared runner.
 */
async function checkAccount(plan: RunnerPlan, deps: SetupRunnerDeps, account: AccountRunners, prefixes: string[]): Promise<{ stack: RunnerStackInfo; runner: RunnerDto } | undefined> {
  const live = account.own.filter((o) => o.runner.status !== 'revoked');
  const sameLabel = live.find((o) => o.runner.label === plan.label);
  if (sameLabel && sameLabel.stack.region !== plan.region) {
    throw new ValidationError(
      `Your runner "${plan.label}" lives in ${where(sameLabel.stack)}. Update it there: `
      + `pipeline-manager infra setup-runner --label ${plan.label} --region ${sameLabel.stack.region} (one runner covers every region in --regions).`, 'region');
  }
  const other = live.find((o) => o.runner.label !== plan.label);
  if (other) {
    const o = other;
    throw new ValidationError(
      `This AWS account already has your organization's runner "${o.runner.label}" (${o.runner.id}, ${where(o.stack)}). `
      + 'An organization has at most one runner per AWS account: one runner covers every region it lists, so update that one instead: '
      + `pipeline-manager infra setup-runner --label ${o.runner.label} --region ${o.stack.region} --regions <every region it should act in>.`, 'label');
  }
  const revoked = account.own.find((o) => o.runner.status === 'revoked' && o.runner.label === plan.label);
  if (!sameLabel && revoked) {
    throw new ValidationError(
      `${where(revoked.stack)} belongs to runner ${revoked.runner.id}, which the platform has revoked. `
      + `Remove it with "pipeline-manager infra setup-runner --label ${plan.label} --region ${revoked.stack.region} --delete", then install again.`, 'label');
  }
  if (sameLabel) return sameLabel;

  if (account.inherited.length > 0) {
    const names = account.inherited.map((i) => `"${i.runner.label}" of ${i.runner.fromOrgName ?? 'your parent organization'} (${where(i.stack)})`).join(', ');
    const msg = `This AWS account already has a parent organization's shared runner: ${names}. Your organization already reaches this account's pipelines through it. `
      + 'If you install your own runner here, your pipelines that it matches move to it (the nearest runner wins) and are signed with your organization\'s key.';
    deps.warn(msg);
    if (!plan.yes && !(await deps.confirm('Install your own runner in this account anyway?'))) {
      throw new ValidationError('Not installed: this account already has your parent organization\'s shared runner. Re-run with --yes to install your own anyway.', 'yes');
    }
  }

  if (account.foreign.length > 0) {
    const overlapping = account.foreign.filter((s) => prefixesOverlap(prefixes, s.prefixes));
    deps.warn(
      `This AWS account already has ${account.foreign.length} runner stack(s) that are not your organization's (${account.foreign.map((s) => where(s)).join(', ')}). `
      + 'Different organizations may each have their own runner in one account, but a shared AWS account is a shared trust boundary: '
      + 'anyone with AWS access here can reach every organization\'s pipelines directly, and each runner\'s role can act on any pipeline in the account that matches its prefixes. '
      + 'Give each organization distinct pipeline-name prefixes (ALLOWED_PIPELINE_PREFIXES, set with --pipeline-prefix).'
      + (overlapping.length > 0
        ? ` Your prefixes (${prefixes.join(', ')}) overlap those of ${overlapping.map((s) => s.stackName).join(', ')} (${[...new Set(overlapping.flatMap((s) => s.prefixes))].join(', ')}).`
        : ''),
    );
  }
  return undefined;
}

// ─── Signing key ─────────────────────────────────────────────────────────────

/** The key the org's runners verify with, when it has one: its own active/next, or (inherit mode) its parent's active. */
function effectiveKid(sk: RunnerSigningKeyDto): string | null {
  if (sk.mode === 'inherit') return sk.inheritedFrom?.activeKid ?? sk.active?.kid ?? null;
  return sk.active?.kid ?? sk.next?.kid ?? null;
}

/**
 * Make sure requests to the runner can be signed, before anything is created:
 * an existing key passes; a root org registering a new runner gets its key from
 * the platform with that registration; --generate-key creates one (step-up);
 * anything else is refused with what to do.
 */
async function ensureSigningKey(plan: RunnerPlan, deps: SetupRunnerDeps, sk: RunnerSigningKeyDto | null, willRegister: boolean): Promise<SigningKeyStatus> {
  if (!sk) throw new Error(runnersUnavailableMessage(null));
  if (sk.unreadable) throw new Error(KEY_UNREADABLE_MESSAGE);
  const kid = effectiveKid(sk);
  if (kid) {
    return sk.mode === 'inherit' && sk.inheritedFrom
      ? { origin: 'inherited', kid, inheritedFrom: sk.inheritedFrom.orgName }
      : { origin: 'existing', kid };
  }
  if (sk.mode === 'inherit') throw new Error(inheritedNoKeyMessage(sk.inheritedFrom?.orgName));
  if (plan.generateKey) {
    try {
      const created = unwrapData<RunnerSigningKeyDto>(await deps.platform.post(SIGNING_KEY_ROUTE, {}, await stepUpHeaders(deps)));
      return { origin: 'generated', kid: created?.active?.kid ?? null };
    } catch (err) {
      // Lost a race (another admin, or a concurrent registration, just created it): the key exists, which is all this run needs.
      if (apiRefusal(err).code === 'RUNNER_KEY_EXISTS') return { origin: 'existing', kid: null };
      return explainRunnerError(err);
    }
  }
  if (sk.isRootOrg && willRegister) return { origin: 'with-first-runner', kid: null };
  throw new Error(NO_ORG_KEY_MESSAGE);
}

// ─── Install / update ────────────────────────────────────────────────────────

async function registerRunner(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<RunnerDto> {
  const created = unwrapData<{ runner?: RunnerDto }>(await guarded(async () => deps.platform.post(
    RUNNERS_ROUTE, { label: plan.label, regions: plan.regions }, await stepUpHeaders(deps),
  )));
  if (!created.runner?.id) throw new Error('The platform registered the runner but returned no runner id');
  return created.runner;
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
  const patched = unwrapData<{ runner?: RunnerDto }>(await guarded(async () => deps.platform.patch(
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

/** The runner's own JWKS URL (absolute). */
export function runnerJwksUrl(platformBaseUrl: string, runnerId: string): string {
  return `${platformBaseUrl.replace(/\/+$/, '')}${runnerJwksPath(runnerId)}`;
}

/** Install or update a runner. */
export async function setupRunnerFlow(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<SetupRunnerResult> {
  // First call: runners unavailable stops here, before anything is created in AWS.
  const list = await listRunners(deps);
  const prefixes = await resolvePrefixes(plan, deps);
  const account = classifyAccountRunners((await accountRunnerStacks(plan, deps)).stacks, list);
  const existing = await checkAccount(plan, deps, account, prefixes);

  // Which runner this stack is: this org's runner already in the account, else a
  // pending one left by an interrupted install of this label, else a new one.
  const pending = existing ? undefined : list.own.find((r) => r.label === plan.label && r.status === 'pending');
  const bound = existing?.runner ?? pending;
  const signingKey = await ensureSigningKey(plan, deps, list.signingKey, !bound);
  const runner = bound ?? await registerRunner(plan, deps);
  const action: SetupRunnerResult['action'] = bound ? 'updated' : 'created';

  const stackName = runnerStackName(runner.id);
  const bundleSha256 = deps.bundleSha256();
  const template = buildRunnerTemplate({ regions: plan.regions, prefixes, apiGateway: plan.apiGateway, allowIps: plan.allowIps });
  // ONE deploy, already bound: the runner accepts only requests addressed to runner.id.
  await deps.deployStack({
    stackName,
    template,
    parameters: runnerStackParameters({
      regions: plan.regions,
      prefixes,
      apiGateway: plan.apiGateway,
      allowIps: plan.allowIps,
      waf: plan.waf,
      ...(plan.waf ? { wafRateLimit: plan.wafRateLimit } : {}),
      runnerId: runner.id,
      platformBaseUrl: deps.platformBaseUrl,
      version: APP_VERSION,
    }),
    tags: { [RUNNER_LABEL_TAG]: plan.label },
    region: plan.region,
  });
  await deps.uploadCode(runnerFunctionName(runner.id), plan.region);

  const functionUrl = (await deps.describeStack(stackName, plan.region))?.outputs.EndpointUrl;
  if (!functionUrl) throw new Error(`Stack ${stackName} has no EndpointUrl output`);
  const { status, test } = await activateOrTest(deps, runner, functionUrl);
  const eventsStack = await ensureEventReporting(plan, deps);

  return {
    action,
    runnerId: runner.id,
    label: plan.label,
    stackName,
    region: plan.region,
    regions: plan.regions,
    prefixes,
    ...(status ? { status } : {}),
    ...(test ? { test } : {}),
    jwksUrl: runnerJwksUrl(deps.platformBaseUrl, runner.id),
    signingKey,
    bundleSha256,
    eventsStack,
  };
}

/**
 * Revoke on the platform, THEN delete the stack. The runner is this org's
 * runner with that label among the account's runner stacks; without one, only a
 * PENDING runner of that label (an install that never got this far) is revoked
 * by label — an active one lives in another account or region, and revoking it
 * from the wrong account would silently cut that one off. A stack whose runner
 * is not this org's is never touched.
 */
export async function deleteRunner(plan: RunnerPlan, deps: SetupRunnerDeps): Promise<SetupRunnerResult> {
  const list = await listRunners(deps);
  const scan = await accountRunnerStacks(plan, deps);
  const account = classifyAccountRunners(scan.stacks, list);
  const mine = account.own.filter((o) => o.runner.label === plan.label);
  const found = mine.find((o) => o.stack.region === plan.region) ?? mine[0];
  if (found && found.stack.region !== plan.region) {
    throw new ValidationError(
      `Your runner "${plan.label}" lives in ${where(found.stack)}: re-run --delete with --region ${found.stack.region}.`, 'region');
  }

  let runnerId = found?.runner.id;
  if (!runnerId) {
    const byLabel = list.own.filter((r) => r.label === plan.label && r.status !== 'revoked');
    runnerId = byLabel.find((r) => r.status === 'pending')?.id;
    if (!runnerId && byLabel.length > 0) {
      throw new ValidationError(
        `Runner "${plan.label}" is active, but there is no stack of it in any of this account's ${scan.regions.length} enabled regions with these AWS credentials: it is installed in another AWS account. `
        + `Re-run --delete there (--profile), or revoke it under ${RUNNERS_PANEL}.`, 'label');
    }
  }
  if (!runnerId) {
    const others = account.own.map((o) => `"${o.runner.label}" (${where(o.stack)})`);
    throw new ValidationError(`No runner "${plan.label}" found (no stack of it in any of this account's ${scan.regions.length} enabled regions, no pending platform runner with that label)`
      + (others.length ? `. This account has your runner ${others.join(', ')}.` : ''), 'label');
  }

  try {
    await deps.platform.delete(`${RUNNERS_ROUTE}/${encodeURIComponent(runnerId)}`, await stepUpHeaders(deps));
  } catch (err) {
    // Never delete the stack of a runner the platform still has: only the runner
    // route's own 404 (NOT_FOUND: no such runner of this org) means it is gone. A
    // bare 404 from a proxy or a missing route says nothing about the runner.
    const r = apiRefusal(err);
    if (r.status !== 404 || r.code !== 'NOT_FOUND') explainRunnerError(err);
    deps.warn('The platform has no such runner any more — removing the stack only');
  }
  if (found) await deps.deleteStack(found.stack.stackName, found.stack.region);
  return {
    action: 'deleted', runnerId, label: plan.label, stackName: found?.stack.stackName ?? runnerStackName(runnerId), region: plan.region, regions: plan.regions,
  };
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

type RealDeps = 'deployStack' | 'describeStack' | 'enabledRegions' | 'listRunnerStacks' | 'deleteStack' | 'uploadCode' | 'bundleSha256' | 'runSetupEvents' | 'confirm' | 'warn';

/** Every stack status but DELETE_COMPLETE: the ListStacks filter for stacks that still exist. */
const LIVE_STACK_STATUSES: StackStatus[] = [
  'CREATE_IN_PROGRESS', 'CREATE_FAILED', 'CREATE_COMPLETE', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_FAILED', 'ROLLBACK_COMPLETE',
  'DELETE_IN_PROGRESS', 'DELETE_FAILED', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_COMPLETE',
  'UPDATE_FAILED', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED', 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
  'UPDATE_ROLLBACK_COMPLETE', 'REVIEW_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_IN_PROGRESS',
  'IMPORT_ROLLBACK_FAILED', 'IMPORT_ROLLBACK_COMPLETE',
];

/** One region's runner stacks: list the stack summaries, keep the runner-prefixed names, describe only those. */
async function listRegionRunnerStacks(region: string): Promise<RunnerStackInfo[]> {
  const cfn = new CloudFormationClient({ region });
  const names: string[] = [];
  let next: string | undefined;
  do {
    const page = await cfn.send(new ListStacksCommand({ StackStatusFilter: LIVE_STACK_STATUSES, ...(next ? { NextToken: next } : {}) }));
    for (const s of page.StackSummaries ?? []) if (s.StackName?.startsWith(RUNNER_STACK_PREFIX)) names.push(s.StackName);
    next = page.NextToken;
  } while (next);
  const described = await Promise.all(names.map(async (name) => (await cfn.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]));
  return described.flatMap((s) => { const info = s ? runnerStackInfo(s, region) : undefined; return info ? [info] : []; });
}

/** A DescribeStacks entry as {@link RunnerStackInfo}, or undefined when it is not a runner stack. */
export function runnerStackInfo(s: Stack, region: string): RunnerStackInfo | undefined {
  if (!s.StackName?.startsWith(RUNNER_STACK_PREFIX) || s.StackStatus === 'DELETE_COMPLETE') return undefined;
  const params = Object.fromEntries((s.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? '']));
  const label = (s.Tags ?? []).find((t) => t.Key === RUNNER_LABEL_TAG)?.Value;
  return {
    stackName: s.StackName,
    region,
    ...(params.RunnerId ? { runnerId: params.RunnerId } : {}),
    ...(label ? { label } : {}),
    prefixes: csv(params.AllowedPipelinePrefixes),
  };
}

function realAwsDeps(profile: string | undefined, interactive: boolean): Pick<SetupRunnerDeps, RealDeps> {
  return {
    bundleSha256: () => sha256OfFile(runnerBundlePath()),
    async runSetupEvents(region) {
      // The existing command, exactly as an operator would run it (same CLI build).
      const args = [process.argv[1]!, 'infra', 'setup-events', '--scoped-ingest', '--region', region, ...(profile ? ['--profile', profile] : [])];
      execFileSync(process.execPath, args, { stdio: ['inherit', 2, 2] });
    },
    warn: (m) => printWarning(m),
    async confirm(question) {
      if (!interactive) return false;
      // stderr: stdout stays clean for --json.
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    async enabledRegions(region) {
      // The AWS CLI (already this command's deploy path) rather than another SDK client.
      const args = ['ec2', 'describe-regions', '--no-all-regions', '--query', 'Regions[].RegionName', '--output', 'json', '--region', region,
        ...(profile ? ['--profile', profile] : [])];
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile('aws', args, { encoding: 'utf-8' }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out)));
      });
      const regions: unknown = JSON.parse(stdout);
      if (!Array.isArray(regions) || !regions.every((r) => typeof r === 'string' && REGION_RE.test(r))) {
        throw new Error('describe-regions answered no region list');
      }
      return regions as string[];
    },
    async listRunnerStacks(regions, required) {
      return scanRegionStacks(regions, required, listRegionRunnerStacks, (m) => printWarning(m));
    },
    async deployStack({ stackName, template, parameters, tags, region }) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-stack-'));
      try {
        const file = path.join(tmp, 'runner-stack.json');
        fs.writeFileSync(file, JSON.stringify(template));
        const args = ['cloudformation', 'deploy', '--stack-name', stackName, '--template-file', file,
          '--parameter-overrides', ...parameters, '--tags', ...Object.entries(tags).map(([k, v]) => `${k}=${v}`), '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--region', region];
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

function describeSigningKey(k: SigningKeyStatus): string {
  if (k.origin === 'inherited') return `${k.kid} (inherited from ${k.inheritedFrom ?? 'the parent organization'})`;
  if (k.origin === 'generated') return `${k.kid ?? '(created)'} (generated now)`;
  if (k.origin === 'with-first-runner') return 'created by the platform with this runner';
  return k.kid ?? '(none)';
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
    ...(r.jwksUrl ? { 'JWKS URL': r.jwksUrl } : {}),
    ...(r.signingKey ? { 'Signing Key': describeSigningKey(r.signingKey) } : {}),
    ...(r.bundleSha256 ? { 'Bundle SHA-256': r.bundleSha256 } : {}),
    ...(r.eventsStack ? { 'Event Reporting': r.eventsStack === 'missing' ? 'not set up in this region' : '✓' } : {}),
  });
  if (r.test && !r.test.ok) printWarning('The test ping failed — check the runner\'s CloudWatch logs, then retest from Settings → Organization → Pipeline runners.');
  if (r.action !== 'deleted') {
    printInfo(`The runner verifies every request against its own key set: ${r.jwksUrl ?? 'its JWKS URL'}. See the signing key with "pipeline-manager runner signing-key status".`);
    printSuccess(`Runner ${r.action}. Remove it with: pipeline-manager infra setup-runner --label ${r.label} --region ${r.region} --delete`);
  }
}

/** The rule, after the options in `setup-runner --help`. */
export const SETUP_RUNNER_HELP = `
One runner per AWS account per organization:
  Your organization has at most one runner in an AWS account. One runner covers every
  region it lists in --regions, so update it (same --label and --region) rather than
  adding another; a second one for your organization is refused. setup-runner lists the
  account's runner stacks (${STACK_NAME_PATTERN}) in EVERY enabled region of the
  account (ec2:DescribeRegions, read in parallel; the stack region and --regions must be
  readable, any other unreadable region is warned and skipped) and reads each one's
  RUNNER_ID to check this; the platform never learns the account id. The same scan
  finds the runner for --delete. The credentials need ec2:DescribeRegions and
  cloudformation:ListStacks / DescribeStacks.

  Another organization may have its own runner in the same account. That is allowed, but a
  shared AWS account is a shared trust boundary: anyone with AWS access there can reach
  both organizations' pipelines directly. Give each organization distinct pipeline-name
  prefixes (--pipeline-prefix, the runner's ALLOWED_PIPELINE_PREFIXES).

  A team already reaches an account through its parent organization's shared runner. If
  that runner is in the account, setup-runner warns and asks before installing the team's
  own runner (--yes to skip the question); the team's own runner then wins for its pipelines.

Signing key:
  The platform signs every request with your organization's runner signing key, and the
  runner verifies it against its own key set, <platform>${JWKS_PATH_PATTERN}.
  A top-level organization's key is created with its first runner. If your organization has
  no key, pass --generate-key (step-up) or generate one under ${RUNNERS_PANEL}.
`;

/**
 * Registers `infra setup-runner`.
 *
 * @example
 * ```bash
 * pipeline-manager infra setup-runner --region us-east-1 --regions us-east-1,eu-west-2 --pipeline-prefix acme-
 * pipeline-manager infra setup-runner --region us-east-1 --api-gateway --allow-ip 203.0.113.10/32
 * pipeline-manager infra setup-runner --region us-east-1 --api-gateway --allow-ip 203.0.113.10/32 --waf-rate-limit 500
 * pipeline-manager infra setup-runner --region us-east-1 --generate-key
 * pipeline-manager infra setup-runner --region us-east-1 --label ops --delete
 * pipeline-manager infra setup-runner --region us-east-1 --dry-run --json
 * ```
 */
export function setupRunner(program: Command): void {
  withSslOptions(withProfileOption(program
    .command('setup-runner')
    .description('Install a cross-account pipeline runner in this AWS account (the platform pushes signed run requests to it), or remove it with --delete. '
      + 'One runner per AWS account per organization.')
    .option('--region <region>', 'Region for the runner stack (default: AWS_REGION / the profile\'s region)')
    .option('--regions <csv>', 'Regions the runner may act in (default: the stack region)')
    .option('--pipeline-prefix <csv>', "CodePipeline name prefixes the runner may act on (default: your org's prefix from its registered pipelines; '*' = all, needs --yes)")
    .option('--label <label>', `Runner label, shown on the platform (stack ${STACK_NAME_PATTERN}, tagged ${RUNNER_LABEL_TAG}=<label>)`, 'default')
    .option('--api-gateway', 'Front the runner with an API Gateway restricted to --allow-ip instead of a Function URL', false)
    .option('--allow-ip <cidr...>', 'With --api-gateway: the platform egress CIDRs the API admits')
    .option('--waf-rate-limit <n>', `With --api-gateway: requests per 5 minutes one source IP may send before WAF blocks it (default ${DEFAULT_WAF_RATE_LIMIT})`)
    .option('--no-waf', 'With --api-gateway: do not attach the WAF rate limit (no WAFv2 web ACL)')
    .option('-p, --password <password>', 'Password for the step-up the runner writes require (prefer PLATFORM_PASSWORD)')
    .option('--step-up <method>', 'auto, password, totp or browser', 'auto')
    .option('--no-browser', 'With browser step-up: print the approval URL instead of opening a browser')
    .option('--generate-key', 'If your organization has no runner signing key yet, generate one (step-up) instead of stopping', false)
    .option('--with-events', 'Afterwards run "infra setup-events --scoped-ingest" in the region, so runner-started executions report their progress', false)
    .option('--delete', 'Revoke the runner on the platform, then delete its stack', false)
    .option('-y, --yes', "Confirm --pipeline-prefix '*', and installing beside a parent organization's shared runner", false)
    .option('--dry-run', 'Show what would be deployed without calling AWS or the platform', false)
    .option('--json', 'Output result as JSON', false)))
    .addHelpText('after', SETUP_RUNNER_HELP)
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
          waf: options.waf,
          wafRateLimit: options.wafRateLimit,
          generateKey: options.generateKey,
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
          ...realAwsDeps(options.profile, !!process.stdin.isTTY && !options.json),
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
