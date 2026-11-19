// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-account pipeline runner CONTRACT — the one vocabulary the pipeline
 * service (signer + dispatcher), the runner Lambda (verifier + responder), the
 * `pipeline-manager infra setup-runner` CLI and the dashboard all speak.
 *
 * Dependency-free on purpose (type-only imports at most): the browser imports it
 * through the `@pipeline-builder/api-core/pipeline-runners` subpath, and the
 * runner Lambda bundle (one self-contained file that may import only
 * `@aws-sdk/*` and `node:*`) has esbuild inline it. A value added here reaches
 * every exhaustive map keyed by these unions as a compile error.
 *
 * Wire-format note: every string below is ON THE WIRE (signed claims, HTTP
 * bodies, stored rows). Renaming one is a protocol change, not a refactor.
 */

import type { FeatureFlag } from './feature-flags.js';

// -----------------------------------------------------------------------------
// Feature, tag, endpoints
// -----------------------------------------------------------------------------

/** The per-org, operator-granted feature flag that turns runners on. */
export const RUNNER_FEATURE = 'cross_account_runners' satisfies FeatureFlag;

/** The tag every platform-deployed pipeline carries — the runner's proof of identity. */
export const PIPELINE_ID_TAG = 'pb.pipeline-id';

/** Where the platform publishes the run-request signing keys (appended to PLATFORM_BASE_URL). */
export const RUNNER_JWKS_PATH = '/api/pipelines/runner/jwks.json';

// -----------------------------------------------------------------------------
// Runner rows
// -----------------------------------------------------------------------------

/** `pending`: registered, its endpoint has not answered the platform's ping yet. */
export const RUNNER_STATUSES = ['pending', 'active', 'revoked'] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

/** A runner's delivery health: unreachable after consecutive failed deliveries. */
export const RUNNER_HEALTH = ['healthy', 'unreachable'] as const;
export type RunnerHealth = (typeof RUNNER_HEALTH)[number];

// -----------------------------------------------------------------------------
// Run requests
// -----------------------------------------------------------------------------

export const RUN_REQUEST_STATUSES = ['queued', 'delivering', 'started', 'stopped', 'failed', 'expired'] as const;
export type RunRequestStatus = (typeof RUN_REQUEST_STATUSES)[number];

/** Still waiting to be delivered. */
export const PENDING_RUN_REQUEST_STATUSES = ['queued', 'delivering'] as const satisfies readonly RunRequestStatus[];
export type PendingRunRequestStatus = (typeof PENDING_RUN_REQUEST_STATUSES)[number];

/** Nothing further happens after these. */
export const TERMINAL_RUN_REQUEST_STATUSES = ['started', 'stopped', 'failed', 'expired'] as const satisfies readonly RunRequestStatus[];
export type TerminalRunRequestStatus = (typeof TERMINAL_RUN_REQUEST_STATUSES)[number];

/** What a signed request asks the runner to do. */
export const RUNNER_ACTIONS = ['start', 'stop', 'probe', 'ping', 'status'] as const;
export type RunnerAction = (typeof RUNNER_ACTIONS)[number];

/** The actions recorded as a run request row (a `ping` and a `status` read never are). */
export const RUN_REQUEST_ACTIONS = ['start', 'stop', 'probe'] as const satisfies readonly RunnerAction[];
export type RunRequestAction = (typeof RUN_REQUEST_ACTIONS)[number];

/** A runner's successful answers (`outcome` of a 200). */
export const RUNNER_OUTCOMES = ['started', 'stopped', 'match', 'no_match', 'pong', 'status'] as const;
export type RunnerOutcome = (typeof RUNNER_OUTCOMES)[number];

/** The outcome a successful answer to each action must carry. */
export const EXPECTED_OUTCOMES: Readonly<Record<RunnerAction, readonly RunnerOutcome[]>> = {
  start: ['started'],
  stop: ['stopped'],
  probe: ['match', 'no_match'],
  ping: ['pong'],
  status: ['status'],
};

// -----------------------------------------------------------------------------
// Error codes
// -----------------------------------------------------------------------------

/**
 * Where a code comes from:
 *  - `platform` — the pipeline service answers with it (`code` of the error envelope);
 *  - `runner`   — a runner answers with it (`errorCode` of its 4xx/5xx body);
 *  - `recorded` — the platform records it on a request on its own (never an HTTP answer).
 * Any of them may end up as a failed request's `errorCode`.
 */
export type RunnerErrorCategory = 'platform' | 'runner' | 'recorded';

export interface RunnerErrorMeta {
  /** The HTTP status it is answered with; null for a `recorded` code. */
  readonly httpStatus: number | null;
  /** The dispatcher delivers again on this runner answer (vs. failing the request). */
  readonly retryable: boolean;
  readonly category: RunnerErrorCategory;
}

/** Every runner error code, with its metadata. */
export const RUNNER_ERRORS = {
  // -- The pipeline service's answers --
  RUNNERS_UNAVAILABLE: { httpStatus: 409, retryable: false, category: 'platform' },
  NO_RUNNER: { httpStatus: 409, retryable: false, category: 'platform' },
  RUNNER_UNREACHABLE: { httpStatus: 409, retryable: false, category: 'platform' },
  PIPELINE_NOT_FOUND_IN_RUNNERS: { httpStatus: 404, retryable: false, category: 'platform' },
  AMBIGUOUS_RUNNER: { httpStatus: 409, retryable: false, category: 'platform' },
  RUNNER_PING_FAILED: { httpStatus: 422, retryable: false, category: 'platform' },
  RUNNER_REVOKED: { httpStatus: 409, retryable: false, category: 'platform' },
  RUNNER_LIMIT: { httpStatus: 409, retryable: false, category: 'platform' },
  RUN_REQUEST_RATE_LIMITED: { httpStatus: 429, retryable: false, category: 'platform' },
  TOO_MANY_PENDING: { httpStatus: 429, retryable: false, category: 'platform' },
  RUNNER_UPDATE_REQUIRED: { httpStatus: 409, retryable: false, category: 'platform' },
  RUNNER_PENDING: { httpStatus: 409, retryable: false, category: 'platform' },
  RUNNERS_NOT_ENABLED: { httpStatus: 409, retryable: false, category: 'platform' },
  // -- A runner's answers --
  SIGNATURE_INVALID: { httpStatus: 401, retryable: false, category: 'runner' },
  RUNNER_REFUSED: { httpStatus: 403, retryable: false, category: 'runner' },
  RUNNER_PERMISSION_DENIED: { httpStatus: 403, retryable: false, category: 'runner' },
  PIPELINE_NOT_FOUND: { httpStatus: 404, retryable: false, category: 'runner' },
  AMBIGUOUS_PIPELINE: { httpStatus: 409, retryable: false, category: 'runner' },
  PIPELINE_NOT_TAGGED: { httpStatus: 409, retryable: false, category: 'runner' },
  PIPELINE_IDENTITY_MISMATCH: { httpStatus: 409, retryable: false, category: 'runner' },
  /** The tagging index has not caught up with a fresh deploy (retried briefly). */
  NOT_YET_VISIBLE: { httpStatus: 409, retryable: true, category: 'runner' },
  /** The runner holds this request in flight with no final result yet. */
  DUPLICATE: { httpStatus: 409, retryable: true, category: 'runner' },
  /** Anything unexpected inside the runner (a 5xx; retried). */
  RUNNER_ERROR: { httpStatus: 500, retryable: true, category: 'runner' },
  // -- Recorded by the platform --
  /** Not delivered within the request's lifetime. */
  RUN_REQUEST_EXPIRED: { httpStatus: null, retryable: false, category: 'recorded' },
  /** A discovery probe that found nothing (probe rows only). */
  NO_MATCH: { httpStatus: null, retryable: false, category: 'recorded' },
} as const satisfies Record<string, RunnerErrorMeta>;

export type RunnerErrorCode = keyof typeof RUNNER_ERRORS;
type CodesIn<C extends RunnerErrorCategory> = { [K in RunnerErrorCode]: (typeof RUNNER_ERRORS)[K]['category'] extends C ? K : never }[RunnerErrorCode];
/** Codes the pipeline service answers with on a runner path. */
export type RunnerApiErrorCode = CodesIn<'platform'>;
/** Codes a runner answers with. */
export type RunnerReplyErrorCode = CodesIn<'runner'>;
/** Codes the platform records on a request on its own. */
export type RunnerRecordedErrorCode = CodesIn<'recorded'>;

export const RUNNER_ERROR_CODES = Object.keys(RUNNER_ERRORS) as readonly RunnerErrorCode[];
const codesIn = <C extends RunnerErrorCategory>(c: C): readonly CodesIn<C>[] =>
  RUNNER_ERROR_CODES.filter((k): k is CodesIn<C> => RUNNER_ERRORS[k].category === c);
export const RUNNER_API_ERROR_CODES = codesIn('platform');
export const RUNNER_REPLY_ERROR_CODES = codesIn('runner');

/** Whether `code` is a known runner error code. */
export function isRunnerErrorCode(code: unknown): code is RunnerErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(RUNNER_ERRORS, code);
}

/** The HTTP status a platform or runner code is answered with. */
export function runnerErrorStatus(code: RunnerApiErrorCode | RunnerReplyErrorCode): number {
  return RUNNER_ERRORS[code].httpStatus;
}

// -----------------------------------------------------------------------------
// Delivery failure classes
// -----------------------------------------------------------------------------

/**
 * Why a delivery attempt did not reach the runner, as recorded in a request's
 * `lastDeliveryError` (the runner's `NOT_YET_VISIBLE` / `DUPLICATE` and the
 * platform's `rediscovered` marker may appear there too). `dns_nxdomain` and
 * `aws_403_url_gone` (the Function URL was deleted or its auth changed) mark
 * the runner unreachable at once; the others count toward the threshold.
 */
export const RUNNER_DELIVERY_FAILURE_CLASSES = ['dns_nxdomain', 'aws_403_url_gone', 'conn_refused', 'timeout', 'http_5xx', 'http_429'] as const;
export type RunnerDeliveryFailureClass = (typeof RUNNER_DELIVERY_FAILURE_CLASSES)[number];

// -----------------------------------------------------------------------------
// Executions (CodePipeline's own states, as a started run reports them)
// -----------------------------------------------------------------------------

/** Execution states nothing further happens after (normalized: lower-case, no separators). */
export const TERMINAL_EXECUTION_STATUSES = ['succeeded', 'failed', 'stopped', 'canceled', 'cancelled', 'superseded'] as const;

/** Whether a started run's `executionStatus` is final (case/dash-insensitive). */
export function isTerminalExecutionStatus(s: string | null | undefined): boolean {
  return !!s && (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(s.toLowerCase().replace(/[\s_-]/g, ''));
}

// -----------------------------------------------------------------------------
// The signed run request (compact JWS, EdDSA / Ed25519)
// -----------------------------------------------------------------------------

/** JWS header `typ`. */
export const RUN_REQUEST_TYP = 'pb-run+jwt';
/** JWS header `alg`. */
export const RUN_REQUEST_ALG = 'EdDSA';
/** Claim `iss`. */
export const RUN_REQUEST_ISS = 'pipeline-builder';

/** A run request lives this long, and its signed `exp` never exceeds it. */
export const RUN_REQUEST_TTL_MS = 600_000;
/** The longest `exp - iat` a runner accepts (= the request lifetime). */
export const RUN_REQUEST_MAX_LIFETIME_SECONDS = RUN_REQUEST_TTL_MS / 1000;
/** Clock skew a runner tolerates on `iat` / `exp`. */
export const RUN_REQUEST_CLOCK_SKEW_SECONDS = 120;

/** The claims a signed run request carries. */
export interface RunClaims {
  iss: string;
  /** The runner's id. */
  aud: string;
  /** The request id (a start's clientRequestToken; the runner's replay key). */
  jti: string;
  iat: number;
  exp: number;
  action: RunnerAction;
  /** Every action but `ping`. */
  pipelineId?: string;
  /** Where the pipeline was last seen — a lookup hint, never proof. */
  hint?: { region: string; pipelineName: string };
  /** stop and status only. */
  executionId?: string;
  requestedBy: string;
}
