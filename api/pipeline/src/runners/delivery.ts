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
import { EXPECTED_OUTCOMES } from '@pipeline-builder/api-core/pipeline-runners';
import type { RunnerDeps } from './deps.js';
import type { RunRequestClaimsInput } from './signing.js';
import type { RunnerRow } from './store.js';
import { DELIVERY_TIMEOUT_MS, RUNNER_OUTCOMES, RUNNER_REPLY_ERRORS, type FailureClass, type RunnerOutcome, type RunnerReplyError } from './vocabulary.js';

/** What a runner's answer means for the request. */
export type ReplyVerdict =
  /** The runner did it (or answered the probe/ping). */
  | { kind: 'success'; outcome: RunnerOutcome; executionId?: string; executionStatus?: string; runnerVersion?: string; regions?: string[] }
  /**
   * Try again later. `transport` failures count against the runner's health;
   * `immediate` ones (the host no longer exists, AWS says the Function URL is
   * gone) mark it unreachable at once. `code` is a failure class for
   * `last_delivery_error`, or the runner's own code (DUPLICATE).
   */
  | { kind: 'retry'; code: FailureClass | 'DUPLICATE'; transport: boolean; immediate?: boolean }
  /** The pipeline exists but the tagging API cannot see it yet (retry every 15 s, ≤ 60 s). */
  | { kind: 'not_yet_visible' }
  /** Final refusal with the runner's code. */
  | { kind: 'fail'; code: string; runnerVersion?: string };

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
    if (code === 'DUPLICATE') return { kind: 'retry', code, transport: false };
    return { kind: 'fail', code: REPLY_ERRORS.has(code) ? (code as RunnerReplyError) : 'RUNNER_ERROR', ...(runnerVersion ? { runnerVersion } : {}) };
  }
  if (status < 200 || status >= 300) return { kind: 'fail', code: 'RUNNER_ERROR' };
  const outcome = str(b.outcome, 16);
  if (!outcome || !OUTCOMES.has(outcome)) return { kind: 'fail', code: 'RUNNER_ERROR' };
  const executionId = str(b.executionId, 100);
  const executionStatus = str(b.executionStatus, 32);
  const regions = regionsOf(b.regions);
  return {
    kind: 'success',
    outcome: outcome as RunnerOutcome,
    ...(executionId ? { executionId } : {}),
    ...(executionStatus ? { executionStatus } : {}),
    ...(runnerVersion ? { runnerVersion } : {}),
    ...(regions ? { regions } : {}),
  };
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
  const signer = deps.signer();
  if (!signer) return { kind: 'fail', code: 'RUNNERS_UNAVAILABLE' };
  if (!runner.functionUrl) return { kind: 'fail', code: 'RUNNER_ERROR' };
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
  if (verdict.kind === 'success' && !expected.includes(verdict.outcome)) return { kind: 'fail', code: 'RUNNER_ERROR' };
  deps.metrics.inc('pipeline_runner_delivery_total', { outcome: verdict.kind === 'success' ? verdict.outcome : verdict.kind === 'fail' ? 'refused' : verdict.kind });
  return verdict;
}
