// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One signed request to one runner, and what its answer MEANS.
 *
 * Delivery is a `safeFetch` POST of the compact JWS (`application/jwt`) to the
 * runner's Function URL: 10 s timeout, redirects refused, the vetted IP pinned.
 * The runner's HTTP response is reduced to one {@link ReplyVerdict} that the
 * dispatcher acts on.
 */

import { errorMessage } from '@pipeline-builder/api-core';
import {
  DEPLOY_BUILD_STATES, DEPLOY_STAGES, RUNNER_DEPLOY_METRICS, EXPECTED_OUTCOMES, isDeployJobResultCode, isRunnerKeyServiceUnavailable, parsePipelinePrefixes, parseRunnerCapabilities,
  RUNNER_DELIVERY_FAILURE_CLASSES, RUNNER_ERROR_CODES,
  type DeployBuildState, type DeployJobResultCode, type DeployStage, type RunnerCapability, type RunnersUnavailableReason,
} from '@pipeline-builder/api-core/pipeline-runners';
import type { RunnerDeps } from './deps.js';
import type { RunRequestClaimsInput, RunRequestSigner } from './signing.js';
import type { RunnerRow } from './store.js';
import { DELIVERY_TIMEOUT_MS, RUNNER_OUTCOMES, RUNNER_REPLY_ERRORS, type FailureClass, type RunnerOutcome } from './vocabulary.js';

/** What a runner's answer means for the request. */
export type ReplyVerdict =
  /**
   * The runner did it (or answered the probe/ping). A `pong` carries the
   * bundle's `capabilities` and `pipelinePrefixes` (always, [] when it sent
   * none); `deploying` / `undeploying` the build id; `deploy_status` /
   * `deploy_cancelled` the build state (plus stage and result code).
   */
  | {
    kind: 'success';
    outcome: RunnerOutcome;
    executionId?: string;
    executionStatus?: string;
    runnerVersion?: string;
    regions?: string[];
    capabilities?: RunnerCapability[];
    pipelinePrefixes?: string[];
    buildId?: string;
    buildState?: DeployBuildState;
    stage?: DeployStage | null;
    resultCode?: DeployJobResultCode | null;
  }
  /**
   * Try again later. `transport` failures count against the runner's health;
   * `immediate` ones (the host no longer exists, AWS says the Function URL is
   * gone) mark it unreachable at once. `code` is a failure class for
   * `last_delivery_error`, or the runner's own code (DUPLICATE).
   */
  | { kind: 'retry'; code: FailureClass | 'DUPLICATE' | 'DEPLOY_BUSY'; transport: boolean; immediate?: boolean }
  /** The pipeline exists but the tagging API cannot see it yet (retry every 15 s, ≤ 60 s). */
  | { kind: 'not_yet_visible' }
  /**
   * Final refusal with the runner's code. A platform RUNNERS_UNAVAILABLE carries
   * its `reason` (the operator pause, or the key service unreachable).
   */
  | { kind: 'fail'; code: string; runnerVersion?: string; reason?: RunnersUnavailableReason };

const OUTCOMES = new Set<string>(RUNNER_OUTCOMES);
const REPLY_ERRORS = new Set<string>(RUNNER_REPLY_ERRORS);

const str = (v: unknown, max = 128): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** The runner-reported regions, kept only when they look like AWS region names. */
function regionsOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((r): r is string => typeof r === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(r)).slice(0, 30);
}

/** Interpret a runner's HTTP answer (status + parsed JSON body). */
export function interpretReply(status: number, body: unknown): ReplyVerdict {
  const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body as Record<string, unknown> : {};
  const runnerVersion = str(b.runnerVersion, 32);
  const code = str(b.errorCode, 64);
  if (status === 429) return { kind: 'retry', code: 'http_429', transport: true };
  if (status >= 500) return { kind: 'retry', code: 'http_5xx', transport: true };
  // A 403 the RUNNER did not write (no errorCode): AWS refusing a deleted
  // Function URL, or one whose auth type changed. The runner is gone.
  if (status === 403 && !code) return { kind: 'retry', code: 'aws_403_url_gone', transport: true, immediate: true };
  if (code) {
    if (code === 'NOT_YET_VISIBLE') return { kind: 'not_yet_visible' };
    // DUPLICATE: the runner holds this jti in flight with no final result yet.
    // DEPLOY_BUSY: the deploy project is at its concurrent build limit — delivered
    // again on the backoff, within the request's lifetime (the runner is fine).
    if (code === 'DUPLICATE' || code === 'DEPLOY_BUSY') return { kind: 'retry', code, transport: false };
    // DEPLOY_IN_PROGRESS: the one platform-catalog code a runner may send (its
    // deploy project already builds this pipeline for another request id).
    const known = REPLY_ERRORS.has(code) || code === 'DEPLOY_IN_PROGRESS';
    return { kind: 'fail', code: known ? code : 'RUNNER_ERROR', ...(runnerVersion ? { runnerVersion } : {}) };
  }
  if (status < 200 || status >= 300) return { kind: 'fail', code: 'RUNNER_ERROR' };
  const outcome = str(b.outcome, 16);
  if (!outcome || !OUTCOMES.has(outcome)) return { kind: 'fail', code: 'RUNNER_ERROR' };
  const executionId = str(b.executionId, 100);
  const executionStatus = str(b.executionStatus, 32);
  const regions = regionsOf(b.regions);
  const deploy = deployDetailsOf(outcome as RunnerOutcome, b);
  if (deploy === null) return { kind: 'fail', code: 'RUNNER_ERROR' };
  return {
    kind: 'success',
    outcome: outcome as RunnerOutcome,
    ...(executionId ? { executionId } : {}),
    ...(executionStatus ? { executionStatus } : {}),
    ...(runnerVersion ? { runnerVersion } : {}),
    ...(regions ? { regions } : {}),
    // Only a pong reports what the bundle can do; parsed against the fixed lists.
    ...(outcome === 'pong' ? { capabilities: parseRunnerCapabilities(b.capabilities), pipelinePrefixes: parsePipelinePrefixes(b.pipelinePrefixes) } : {}),
    ...deploy,
  };
}

/** A CodeBuild build id: `<project>:<uuid>` (never an ARN, so never an account id). */
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}:[0-9a-f-]{36}$/;

/**
 * The deploy details an outcome must carry, validated against the fixed lists:
 * `deploying` / `undeploying` a build id; `deploy_status` a build state (stage
 * and result code optional, dropped when unknown); `deploy_cancelled` a build
 * state. Null when a required one is missing or malformed (the answer is
 * RUNNER_ERROR); {} for every other outcome.
 */
function deployDetailsOf(outcome: RunnerOutcome, b: Record<string, unknown>): Partial<Extract<ReplyVerdict, { kind: 'success' }>> | null {
  const state = typeof b.buildState === 'string' && (DEPLOY_BUILD_STATES as readonly string[]).includes(b.buildState) ? b.buildState as DeployBuildState : undefined;
  switch (outcome) {
    case 'deploying':
    case 'undeploying':
      return typeof b.buildId === 'string' && BUILD_ID_PATTERN.test(b.buildId) ? { buildId: b.buildId } : null;
    case 'deploy_status': {
      if (!state) return null;
      const stage = typeof b.stage === 'string' && (DEPLOY_STAGES as readonly string[]).includes(b.stage) ? b.stage as DeployStage : null;
      const resultCode = isDeployJobResultCode(b.resultCode) ? b.resultCode : null;
      return { buildState: state, stage, resultCode };
    }
    case 'deploy_cancelled':
      return state ? { buildState: state } : null;
    default:
      return {};
  }
}

/** The outcome a successful answer to each action must carry (the shared contract). */
export { EXPECTED_OUTCOMES };

/** The failure class of a thrown transport error. */
export function failureClassOf(err: unknown): { code: FailureClass; immediate: boolean } {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const sysCode = String(e?.code ?? e?.cause?.code ?? '');
  const msg = errorMessage(err).toLowerCase();
  if (sysCode === 'ENOTFOUND' || /enotfound|nxdomain|getaddrinfo/.test(msg)) return { code: 'dns_nxdomain', immediate: true };
  if (/timeout|timed out|abort/.test(msg) || sysCode === 'ETIMEDOUT') return { code: 'timeout', immediate: false };
  return { code: 'conn_refused', immediate: false };
}

/**
 * POST a signed request to a runner and interpret the answer. Never
 * throws: a timeout, a refused connection, an SSRF refusal or a redirect is a
 * verdict too. Nothing about the URL reaches a log or the verdict.
 */
export async function deliverPush(deps: RunnerDeps, runner: RunnerRow, claims: RunRequestClaimsInput): Promise<ReplyVerdict> {
  // The system-org pause: nothing is signed or delivered while it is on.
  if (await deps.deliveriesPaused()) return { kind: 'fail', code: 'RUNNERS_UNAVAILABLE', reason: 'paused' };
  if (!runner.functionUrl) return { kind: 'fail', code: 'RUNNER_ERROR' };
  // The OWNING org's effective key, from the runner row — never from the request.
  let signer: RunRequestSigner;
  try {
    signer = await deps.signerFor(runner.orgId);
  } catch (err) {
    const e = err as { code?: unknown; reason?: unknown; details?: { reason?: unknown } } | null;
    if (e?.code === 'RUNNER_KEY_MISSING' || e?.code === 'RUNNER_KEY_UNREADABLE') return { kind: 'fail', code: e.code };
    // The key service unreachable (a RunnerRouteError from the signer, or the raw error) says so.
    const reason = isRunnerKeyServiceUnavailable(err) ? err.reason : e?.details?.reason;
    return { kind: 'fail', code: 'RUNNERS_UNAVAILABLE', ...(reason === 'key_service' ? { reason } : {}) };
  }
  const jws = signer.sign(claims);
  let verdict: ReplyVerdict;
  try {
    const res = await deps.fetch(runner.functionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/jwt', 'accept': 'application/json' },
      body: jws,
      timeoutMs: DELIVERY_TIMEOUT_MS,
      maxResponseBytes: 64 * 1024,
    });
    if (res.redirected) {
      verdict = { kind: 'fail', code: 'RUNNER_ERROR' };
    } else {
      let parsed: unknown = {};
      try { parsed = res.json(); } catch { parsed = {}; }
      verdict = interpretReply(res.status, parsed);
    }
  } catch (err) {
    const cls = failureClassOf(err);
    verdict = { kind: 'retry', code: cls.code, transport: true, ...(cls.immediate ? { immediate: true } : {}) };
  }
  const expected = EXPECTED_OUTCOMES[claims.action] ?? [];
  if (verdict.kind === 'success' && !expected.includes(verdict.outcome)) verdict = { kind: 'fail', code: 'RUNNER_ERROR' };
  deps.metrics.inc(DELIVERY_METRIC, { outcome: deliveryOutcomeLabel(verdict), code: deliveryCodeLabel(verdict) });
  return verdict;
}

// -- Metrics ---------------------------------------------------------------------

/** `pipeline_runner_delivery_total{outcome, code}` — one per answered (or failed) delivery attempt. */
export const DELIVERY_METRIC = 'pipeline_runner_delivery_total';

/**
 * Every value the `code` label can take: the catalog's runner error codes, the
 * delivery failure classes, and `none` (a success). Bounded on purpose — a
 * runner id, an org id or a URL never becomes a label value.
 */
export const DELIVERY_METRIC_CODES: ReadonlySet<string> = new Set<string>([...RUNNER_ERROR_CODES, ...RUNNER_DELIVERY_FAILURE_CLASSES, 'none']);

/** The `outcome` label: the runner's outcome on success, else the verdict kind (`refused` for a final refusal). */
function deliveryOutcomeLabel(v: ReplyVerdict): string {
  return v.kind === 'success' ? v.outcome : v.kind === 'fail' ? 'refused' : v.kind;
}

/** The code a non-success verdict carries (`NOT_YET_VISIBLE` has none of its own); undefined for a success. */
export function verdictCode(v: ReplyVerdict): string | undefined {
  return v.kind === 'success' ? undefined : v.kind === 'not_yet_visible' ? 'NOT_YET_VISIBLE' : v.code;
}

/** The `code` label of a verdict — always a member of {@link DELIVERY_METRIC_CODES}. */
export function deliveryCodeLabel(v: ReplyVerdict): string {
  const code = verdictCode(v) ?? 'none';
  return DELIVERY_METRIC_CODES.has(code) ? code : 'none';
}

/** The refusal codes the alert rules watch (RunnerSignatureInvalid, RunnerRefusalSpike). */
const ALERTED_REFUSALS = ['SIGNATURE_INVALID', 'RUNNER_REFUSED', 'PIPELINE_IDENTITY_MISMATCH', 'AMBIGUOUS_PIPELINE'] as const;

/**
 * Create the alerted series at zero. A counter series that first appears at 1
 * has no earlier sample, so `increase()` reads it as 0 — without this the
 * FIRST signature failure after a restart would never fire its alert.
 */
export function primeRunnerMetrics(deps: RunnerDeps): void {
  for (const code of ALERTED_REFUSALS) deps.metrics.inc(DELIVERY_METRIC, { outcome: 'refused', code }, 0);
  deps.metrics.inc('pipeline_runner_requests_total', { status: 'expired' }, 0);
  // The deploy alerts (RunnerDeployGrantReuse, RunnerDeployPlatformFailures).
  deps.metrics.inc(RUNNER_DEPLOY_METRICS.grantRejections, { reason: 'reused' }, 0);
  deps.metrics.inc(RUNNER_DEPLOY_METRICS.failuresByClass, { class: 'platform' }, 0);
}
