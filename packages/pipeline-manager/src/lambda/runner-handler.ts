// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CROSS-ACCOUNT PIPELINE RUNNER — a Lambda in a customer AWS account that
 * starts and stops that account's pipelines with its OWN role, on signed
 * requests from the platform. Deployed by `pipeline-manager infra setup-runner`
 * (stack template: src/templates/runner-stack.json, completed by
 * utils/runner-template.ts). The platform holds no AWS access, no role and no
 * account number for this account; all it ever learns back is an outcome, an
 * execution id or an error code.
 *
 * PUSH ONLY: the platform POSTs the signed request (body `application/jwt`)
 * to this function's URL — or the optional API Gateway front that admits only
 * the platform's egress IPs — and the result is the HTTP response. The runner
 * holds NO platform credential: nothing to store, rotate or leak. Its identity
 * is its endpoint plus the signatures it verifies.
 *
 * Every request, in order:
 *   1. the JWS verifies (runner-jws.ts): a key from this runner's own JWKS
 *      (PLATFORM_BASE_URL + runnerJwksPath(RUNNER_ID): the owning org's keys
 *      only; a 404 there means no keys and fails closed), typ/alg, iss, aud ==
 *      RUNNER_ID (no RUNNER_ID → everything is refused), iat/exp with 120 s
 *      skew — else 401 SIGNATURE_INVALID, before any AWS call;
 *   2. its jti was not seen in the last 15 min (a repeat returns the earlier
 *      final result, else 409 DUPLICATE);
 *   3. the pipeline is FOUND BY ITS `pb.pipeline-id` TAG (tag:GetResources, each
 *      allowlisted region, the hint's region first, every page) — exactly one
 *      match. The platform's name/region is only a fallback HINT, checked with
 *      ListTagsForResource and used only when its tag matches;
 *   4. the match is inside the local allowlist (ALLOWED_REGIONS,
 *      ALLOWED_PIPELINE_PREFIXES) — set by the customer, unchangeable by the
 *      platform;
 *   5. start (clientRequestToken = requestId) / stop (the execution must belong
 *      to that pipeline) / status (read-only GetPipelineExecution) / probe
 *      (lookup only, never acts) / ping.
 *
 * Steps 1-2 run before any AWS call; the jti cache is per container (see
 * ReplayCache) and clientRequestToken is what makes a start idempotent.
 *
 * NEVER logged or returned: the account id, any ARN, keys, tokens, signatures.
 *
 * Env: RUNNER_ID, PLATFORM_BASE_URL, ALLOWED_REGIONS (csv), ALLOWED_PIPELINE_PREFIXES
 *      (csv, '*' = every pipeline), RUNNER_VERSION.
 */

import {
  CodePipelineClient, GetPipelineExecutionCommand, StartPipelineExecutionCommand, StopPipelineExecutionCommand,
} from '@aws-sdk/client-codepipeline';
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import {
  PIPELINE_ID_TAG, RUNNER_ERRORS, runnerJwksPath,
  type RunnerOutcome, type RunnerReplyErrorCode,
} from '@pipeline-builder/api-core/pipeline-runners';
import { readPipelineIdTag, type Sender } from './pipeline-tag.js';
import {
  JwksCache, JwksUnavailableError, ReplayCache, SignatureError, verifyRunRequest,
  type FetchFn, type RunClaims,
} from './runner-jws.js';

const MAX_BODY_BYTES = 16 * 1024;

// ─── Response vocabulary (the shared contract: api-core's pipeline-runners) ──

export type Outcome = RunnerOutcome;
/** The codes this runner answers with on a 4xx (RUNNER_ERROR is the bare 5xx). */
export type RunnerErrorCode = Exclude<RunnerReplyErrorCode, 'RUNNER_ERROR'>;

export interface RunnerResult {
  status: number;
  body:
    | { outcome: Outcome; executionId?: string; executionStatus?: string; runnerVersion: string; regions?: string[] }
    | { errorCode: RunnerErrorCode; runnerVersion: string }
    | { errorCode: 'RUNNER_ERROR' };
}

// ─── Configuration & dependencies ────────────────────────────────────────────

export interface RunnerConfig {
  /** This runner's platform id — `aud` must equal it. Without one every request is refused. */
  runnerId?: string;
  platformBaseUrl: string;
  allowedRegions: string[];
  /** Pipeline-name prefixes the runner may act on; `'*'` = every pipeline in the allowed regions. */
  allowedPrefixes: string[];
  version: string;
}

export type { Sender };

export interface RunnerDeps {
  fetch: FetchFn;
  now: () => number;
  tagging: (region: string) => Sender;
  codepipeline: (region: string) => Sender;
  log: (level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) => void;
}

/** The runner's own account, from the invoked function's ARN — used to build lookups, never logged. */
export interface AccountContext { partition: string; accountId: string }

const csv = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Read and validate the runner configuration from the environment. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): RunnerConfig {
  const platformBaseUrl = (env.PLATFORM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!platformBaseUrl) throw new Error('PLATFORM_BASE_URL environment variable is required');
  if (!/^https:\/\//.test(platformBaseUrl) && env.NODE_ENV === 'production') {
    throw new Error('PLATFORM_BASE_URL must be https');
  }
  const allowedRegions = csv(env.ALLOWED_REGIONS);
  if (allowedRegions.length === 0) throw new Error('ALLOWED_REGIONS environment variable is required');
  const allowedPrefixes = csv(env.ALLOWED_PIPELINE_PREFIXES);
  if (allowedPrefixes.length === 0) throw new Error('ALLOWED_PIPELINE_PREFIXES environment variable is required');
  return {
    runnerId: env.RUNNER_ID?.trim() || undefined,
    platformBaseUrl,
    allowedRegions,
    allowedPrefixes,
    version: env.RUNNER_VERSION?.trim() || '0.0.0',
  };
}

function defaultLog(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, ...data });
  // eslint-disable-next-line no-console
  if (level === 'ERROR') console.error(line); else console.log(line);
}

/** Real AWS / HTTP / clock dependencies (SDK clients cached per region for the container's life). */
export function defaultDeps(): RunnerDeps {
  const tagging = new Map<string, ResourceGroupsTaggingAPIClient>();
  const cp = new Map<string, CodePipelineClient>();
  return {
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
    tagging: (region) => {
      if (!tagging.has(region)) tagging.set(region, new ResourceGroupsTaggingAPIClient({ region }));
      return tagging.get(region)!;
    },
    codepipeline: (region) => {
      if (!cp.has(region)) cp.set(region, new CodePipelineClient({ region }));
      return cp.get(region)!;
    },
    log: defaultLog,
  };
}

/** `arn:<partition>:lambda:<region>:<account>:function:<name>` → the partition and account. */
export function accountFromFunctionArn(arn: string | undefined): AccountContext | undefined {
  const m = /^arn:([a-z-]+):lambda:[a-z0-9-]+:(\d{12}):function:/.exec(arn ?? '');
  return m ? { partition: m[1]!, accountId: m[2]! } : undefined;
}

/** Region + name of a CodePipeline ARN (`arn:<p>:codepipeline:<region>:<account>:<name>`). */
export function parsePipelineArn(arn: string): { region: string; accountId: string; name: string } | undefined {
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn' || parts[2] !== 'codepipeline') return undefined;
  const name = parts.slice(5).join(':');
  if (!parts[3] || !name) return undefined;
  return { region: parts[3], accountId: parts[4] ?? '', name };
}

/** Whether a pipeline (region + name) is inside the local allowlist. */
export function isAllowed(config: Pick<RunnerConfig, 'allowedRegions' | 'allowedPrefixes'>, region: string, name: string): boolean {
  if (!config.allowedRegions.includes(region)) return false;
  return config.allowedPrefixes.some((p) => p === '*' || name.startsWith(p));
}

// ─── Finding the pipeline ────────────────────────────────────────────────────

export type Lookup =
  | { kind: 'found'; region: string; name: string; via: 'tag' | 'hint' }
  /** The tag index lists nothing and there is no hint to check: maybe a fresh deploy the index has not caught up with. */
  | { kind: 'none' }
  /** Not by tag, and the hinted pipeline does not exist either: it is not (or no longer) here. */
  | { kind: 'gone' }
  | { kind: 'ambiguous' }
  | { kind: 'not_tagged' }
  | { kind: 'mismatch' }
  | { kind: 'hint_refused' };

const errName = (err: unknown): string => String((err as { name?: string })?.name ?? '');
const errStatus = (err: unknown): number | undefined => (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

/** AWS refused the runner's role (or its permissions boundary / an SCP). */
export function isAccessDenied(err: unknown): boolean {
  const n = errName(err);
  return n === 'AccessDeniedException' || n === 'AccessDenied' || n === 'UnauthorizedOperation'
    || n === 'AuthorizationErrorException' || (errStatus(err) === 403 && !/Throttl/.test(n));
}

const NOT_FOUND_ERRORS = new Set(['ResourceNotFoundException', 'PipelineNotFoundException', 'InvalidArnException']);

/** Every ARN tagged `pb.pipeline-id = pipelineId`, across the allowlisted regions (hint region first), all pages. */
async function arnsByTag(config: RunnerConfig, deps: RunnerDeps, pipelineId: string, hintRegion?: string): Promise<string[]> {
  const regions = hintRegion && config.allowedRegions.includes(hintRegion)
    ? [hintRegion, ...config.allowedRegions.filter((r) => r !== hintRegion)]
    : [...config.allowedRegions];
  const arns: string[] = [];
  for (const region of regions) {
    let token: string | undefined;
    do {
      const out = await deps.tagging(region).send(new GetResourcesCommand({
        TagFilters: [{ Key: PIPELINE_ID_TAG, Values: [pipelineId] }],
        ResourceTypeFilters: ['codepipeline:pipeline'],
        ...(token ? { PaginationToken: token } : {}),
      })) as { ResourceTagMappingList?: Array<{ ResourceARN?: string; Tags?: Array<{ Key?: string; Value?: string }> }>; PaginationToken?: string };
      for (const m of out.ResourceTagMappingList ?? []) {
        if (!m.ResourceARN) continue;
        // Belt and braces: the filter already matched, but act only on what we can see.
        if (m.Tags && !m.Tags.some((t) => t.Key === PIPELINE_ID_TAG && t.Value === pipelineId)) continue;
        const parsed = parsePipelineArn(m.ResourceARN);
        if (parsed && parsed.region === region && !arns.includes(m.ResourceARN)) arns.push(m.ResourceARN);
      }
      token = out.PaginationToken || undefined;
    } while (token);
  }
  return arns;
}

/** The hinted pipeline's `pb.pipeline-id` tag: the value, null when untagged, undefined when it doesn't exist. */
async function hintedTag(deps: RunnerDeps, account: AccountContext, hint: { region: string; pipelineName: string }): Promise<string | null | undefined> {
  const resourceArn = `arn:${account.partition}:codepipeline:${hint.region}:${account.accountId}:${hint.pipelineName}`;
  try {
    return (await readPipelineIdTag(deps.codepipeline(hint.region), resourceArn)) ?? null;
  } catch (err) {
    if (NOT_FOUND_ERRORS.has(errName(err))) return undefined;
    throw err;
  }
}

/**
 * Find the pipeline a request means. The TAG is the proof of identity every
 * time; the hint only says where to look while the tagging index lags a fresh
 * deploy. With nothing found by tag, a hint that names no pipeline is `gone`
 * (PIPELINE_NOT_FOUND: the platform clears a stale link and re-discovers);
 * without a hint it is only `none` (NOT_YET_VISIBLE, retried briefly).
 */
export async function findPipeline(
  config: RunnerConfig,
  deps: RunnerDeps,
  account: AccountContext | undefined,
  pipelineId: string,
  hint?: { region: string; pipelineName: string },
): Promise<Lookup> {
  const arns = await arnsByTag(config, deps, pipelineId, hint?.region);
  if (arns.length > 1) return { kind: 'ambiguous' };
  if (arns.length === 1) {
    const p = parsePipelineArn(arns[0]!)!;
    return { kind: 'found', region: p.region, name: p.name, via: 'tag' };
  }
  if (!hint) return { kind: 'none' };
  if (!isAllowed(config, hint.region, hint.pipelineName)) return { kind: 'hint_refused' };
  if (!account) return { kind: 'none' };
  const tag = await hintedTag(deps, account, hint);
  if (tag === undefined) return { kind: 'gone' };
  if (tag === null) return { kind: 'not_tagged' };
  if (tag !== pipelineId) return { kind: 'mismatch' };
  return { kind: 'found', region: hint.region, name: hint.pipelineName, via: 'hint' };
}

// ─── The runner ──────────────────────────────────────────────────────────────

export interface Runner {
  /** Verify and act on one signed request. */
  process(jws: string, opts?: { account?: AccountContext }): Promise<RunnerResult>;
  /** The Lambda entry point (a Function URL or API Gateway event). */
  handler(event: unknown, context?: { awsRequestId?: string; invokedFunctionArn?: string }): Promise<unknown>;
}

/** The lookup refusals shared by start / stop / status (a probe answers `no_match` instead). */
const LOOKUP_REFUSALS: Readonly<Record<Exclude<Lookup['kind'], 'found'>, RunnerErrorCode>> = {
  none: 'NOT_YET_VISIBLE',
  gone: 'PIPELINE_NOT_FOUND',
  ambiguous: 'AMBIGUOUS_PIPELINE',
  not_tagged: 'PIPELINE_NOT_TAGGED',
  mismatch: 'PIPELINE_IDENTITY_MISMATCH',
  hint_refused: 'RUNNER_REFUSED',
};

/** Final results are replayed for a repeated jti; transient ones are retried afresh. */
function isFinal(r: RunnerResult): boolean {
  if (r.status >= 500) return false;
  return !('errorCode' in r.body && r.body.errorCode === 'NOT_YET_VISIBLE');
}

export function createRunner(config: RunnerConfig, deps: RunnerDeps): Runner {
  // The runner's own key set: its owning org's keys only. Without a RUNNER_ID
  // there is no URL to ask and no key is trusted (every request is refused).
  const jwks: Pick<JwksCache, 'get'> = config.runnerId
    ? new JwksCache(`${config.platformBaseUrl}${runnerJwksPath(config.runnerId)}`, deps.fetch, deps.now)
    : { get: async () => undefined };
  const replay = new ReplayCache<RunnerResult>(deps.now);

  const ok = (outcome: Outcome, extra: { executionId?: string; executionStatus?: string; regions?: string[] } = {}): RunnerResult =>
    ({ status: 200, body: { outcome, ...extra, runnerVersion: config.version } });
  const fail = (errorCode: RunnerErrorCode): RunnerResult =>
    ({ status: RUNNER_ERRORS[errorCode].httpStatus, body: { errorCode, runnerVersion: config.version } });
  const internal = (): RunnerResult => ({ status: RUNNER_ERRORS.RUNNER_ERROR.httpStatus, body: { errorCode: 'RUNNER_ERROR' } });

  /**
   * The execution, read through the pipeline the tag identified (CodePipeline
   * scopes the id to that name, so another pipeline's execution is not found):
   * its state, or the refusal to answer with.
   */
  async function readExecution(cp: Sender, pipelineName: string, executionId: string): Promise<{ executionStatus?: string } | RunnerResult> {
    try {
      const got = await cp.send(new GetPipelineExecutionCommand({ pipelineName, pipelineExecutionId: executionId })) as {
        pipelineExecution?: { pipelineName?: string; status?: string };
      };
      const e = got.pipelineExecution;
      if (e?.pipelineName !== undefined && e.pipelineName !== pipelineName) return fail('RUNNER_REFUSED');
      return { ...(e?.status ? { executionStatus: e.status } : {}) };
    } catch (err) {
      if (errName(err) === 'PipelineNotFoundException') return fail('PIPELINE_NOT_FOUND');
      if (errName(err) === 'PipelineExecutionNotFoundException') return fail('RUNNER_REFUSED');
      throw err;
    }
  }
  const isResult = (v: object): v is RunnerResult => 'body' in v;

  async function start(cp: Sender, name: string, claims: RunClaims): Promise<RunnerResult> {
    try {
      const out = await cp.send(new StartPipelineExecutionCommand({
        name,
        // The request id: a redelivered request starts ONE execution, not two.
        clientRequestToken: claims.jti,
      })) as { pipelineExecutionId?: string };
      return ok('started', out.pipelineExecutionId ? { executionId: out.pipelineExecutionId } : {});
    } catch (err) {
      // Listed by a lagging tag index but already deleted.
      if (errName(err) === 'PipelineNotFoundException') return fail('PIPELINE_NOT_FOUND');
      throw err;
    }
  }

  async function stop(cp: Sender, name: string, claims: RunClaims): Promise<RunnerResult> {
    const executionId = claims.executionId!;
    const execution = await readExecution(cp, name, executionId);
    if (isResult(execution)) return execution;
    // Already stopping/stopped — e.g. a redelivery that reached the other
    // container, whose replay cache never saw it: the same end state.
    if (execution.executionStatus === 'Stopping' || execution.executionStatus === 'Stopped') return ok('stopped', { executionId });
    try {
      await cp.send(new StopPipelineExecutionCommand({
        pipelineName: name,
        pipelineExecutionId: executionId,
        abandon: false,
        reason: `Stopped by pipeline-builder request ${claims.jti}`.slice(0, 200),
      }));
    } catch (err) {
      const n = errName(err);
      if (n === 'DuplicatedStopRequestException') return ok('stopped', { executionId });
      if (n === 'PipelineNotFoundException') return fail('PIPELINE_NOT_FOUND');
      // Finished / not in a stoppable state: refused, nothing was changed.
      if (n === 'PipelineExecutionNotStoppableException' || n === 'PipelineExecutionNotFoundException') return fail('RUNNER_REFUSED');
      throw err;
    }
    return ok('stopped', { executionId });
  }

  /** status — read-only: the execution's state, for a run request whose events never arrived. */
  async function executionStatus(cp: Sender, name: string, claims: RunClaims): Promise<RunnerResult> {
    const execution = await readExecution(cp, name, claims.executionId!);
    if (isResult(execution)) return execution;
    return ok('status', { executionId: claims.executionId!, executionStatus: execution.executionStatus ?? 'Unknown' });
  }

  async function act(claims: RunClaims, account: AccountContext | undefined): Promise<RunnerResult> {
    if (claims.action === 'ping') return ok('pong', { regions: [...config.allowedRegions] });

    const found = await findPipeline(config, deps, account, claims.pipelineId!, claims.hint);
    if (claims.action === 'probe') {
      if (found.kind === 'ambiguous') return fail('AMBIGUOUS_PIPELINE');
      return found.kind === 'found' && isAllowed(config, found.region, found.name) ? ok('match') : ok('no_match');
    }
    if (found.kind !== 'found') return fail(LOOKUP_REFUSALS[found.kind]);
    if (!isAllowed(config, found.region, found.name)) return fail('RUNNER_REFUSED');

    const cp = deps.codepipeline(found.region);
    if (claims.action === 'start') return start(cp, found.name, claims);
    if (claims.action === 'stop') return stop(cp, found.name, claims);
    return executionStatus(cp, found.name, claims);
  }

  async function handleRequest(jws: string, opts: { account?: AccountContext } = {}): Promise<RunnerResult> {
    let claims: RunClaims;
    try {
      claims = await verifyRunRequest(jws, { jwks, runnerId: config.runnerId, now: deps.now });
    } catch (err) {
      if (err instanceof SignatureError) {
        deps.log('WARN', 'Rejected a request that is not validly signed for this runner', { reason: err.message });
        return fail('SIGNATURE_INVALID');
      }
      if (err instanceof JwksUnavailableError) {
        deps.log('ERROR', 'Could not fetch the platform signing keys', { reason: err.message });
        return internal();
      }
      deps.log('ERROR', 'Unexpected verification failure', { error: errName(err) || 'Error' });
      return internal();
    }

    const prior = replay.claim(claims.jti);
    if (prior) {
      deps.log('INFO', 'Repeated request', { requestId: claims.jti, replayed: !!prior.result });
      return prior.result ?? fail('DUPLICATE');
    }

    const logCtx = { requestId: claims.jti, requestedBy: claims.requestedBy, action: claims.action, ...(claims.pipelineId ? { pipelineId: claims.pipelineId } : {}) };
    let result: RunnerResult;
    try {
      result = await act(claims, opts.account);
    } catch (err) {
      if (isAccessDenied(err)) {
        deps.log('ERROR', 'The runner role was refused by AWS — redeploy the runner stack or fix its role', { ...logCtx, error: errName(err) });
        result = fail('RUNNER_PERMISSION_DENIED');
      } else {
        deps.log('ERROR', 'Request failed', { ...logCtx, error: errName(err) || 'Error' });
        result = internal();
      }
    }
    if (isFinal(result)) replay.complete(claims.jti, result);
    else replay.forget(claims.jti);
    const b = result.body as { outcome?: string; errorCode?: string; executionId?: string };
    deps.log('INFO', 'Request handled', { ...logCtx, status: result.status, outcome: b.outcome ?? b.errorCode, ...(b.executionId ? { executionId: b.executionId } : {}) });
    return result;
  }

  async function handleHttp(event: HttpEvent, account: AccountContext | undefined): Promise<HttpResponse> {
    const respond = (r: RunnerResult): HttpResponse => ({
      statusCode: r.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(r.body),
    });
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    const contentType = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    const raw = event.body ?? '';
    const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    if (method !== 'POST' || !/^application\/jwt\s*(;|$)/i.test(contentType) || !body || Buffer.byteLength(body) > MAX_BODY_BYTES) {
      return respond(fail('SIGNATURE_INVALID'));
    }
    return respond(await handleRequest(body, { account }));
  }

  return {
    process: handleRequest,
    async handler(event, context) {
      const account = accountFromFunctionArn(context?.invokedFunctionArn);
      if (isHttpEvent(event)) return handleHttp(event, account);
      deps.log('WARN', 'Ignoring an invocation that is not an HTTP request');
      return { statusCode: 400 };
    },
  };
}

interface HttpEvent {
  requestContext?: { http?: { method?: string } };
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}
interface HttpResponse { statusCode: number; headers: Record<string, string>; body: string }

function isHttpEvent(e: unknown): e is HttpEvent {
  const ev = e as HttpEvent | undefined;
  return !!ev && typeof ev === 'object' && (typeof ev.requestContext?.http?.method === 'string' || typeof ev.httpMethod === 'string');
}

// ─── Lambda entry ────────────────────────────────────────────────────────────

let instance: Runner | undefined;

/** Per-container runner: the JWKS and jti caches live as long as the container. */
export const handler = async (event: unknown, context?: { awsRequestId?: string; invokedFunctionArn?: string }): Promise<unknown> => {
  if (!instance) {
    let config: RunnerConfig;
    try {
      config = configFromEnv();
    } catch (err) {
      defaultLog('ERROR', 'Runner misconfigured', { error: err instanceof Error ? err.message : String(err) });
      return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ errorCode: 'RUNNER_ERROR' }) };
    }
    instance = createRunner(config, defaultDeps());
  }
  return instance.handler(event, context);
};

/** Tests only: drop the per-container runner. */
export function _resetRunnerForTests(): void {
  instance = undefined;
}
