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

// -----------------------------------------------------------------------------
// Tag, endpoints
// -----------------------------------------------------------------------------

/** The tag every platform-deployed pipeline carries — the runner's proof of identity. */
export const PIPELINE_ID_TAG = 'pb.pipeline-id';

/**
 * Where one runner fetches the public keys its run requests are signed with
 * (appended to PLATFORM_BASE_URL): the next, active and retiring keys of the
 * runner's owning org's EFFECTIVE key org. Keyed by the runner's own id, so
 * the runner needs no new setting and no org id ever appears in a URL. An
 * unknown, pending-and-unknown or revoked runner gets 404 (the runner fails
 * closed); a pending runner IS served, so its activation ping verifies.
 */
export function runnerJwksPath(runnerId: string): string {
  return `/api/pipelines/runner/runners/${encodeURIComponent(runnerId)}/jwks.json`;
}

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
  /**
   * The dispatcher delivers again on this code in a runner's 4xx answer (vs.
   * failing the request). Any 5xx is retried as a transport failure, whatever
   * its body says.
   */
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
  /** The org's effective signing key exists but cannot be decrypted (wrong master, rotated KMS key). That org only. */
  RUNNER_KEY_UNREADABLE: { httpStatus: 409, retryable: false, category: 'platform' },
  /** The org has no effective signing key (no shared key to fall back to). */
  RUNNER_KEY_MISSING: { httpStatus: 409, retryable: false, category: 'platform' },
  /** Generate: the org already has a key. */
  RUNNER_KEY_EXISTS: { httpStatus: 409, retryable: false, category: 'platform' },
  /** Rotate / mode switch / revoke while a rotation (a next or retiring key) or a mode switch is in progress. */
  RUNNER_KEY_TRANSITION_IN_PROGRESS: { httpStatus: 409, retryable: false, category: 'platform' },
  /** Cancel with no next key, or finish with no retiring key. */
  RUNNER_KEY_NO_ROTATION: { httpStatus: 409, retryable: false, category: 'platform' },
  /** Finish before the retiring key's retire_after. */
  RUNNER_KEY_RETIRE_TOO_EARLY: { httpStatus: 409, retryable: false, category: 'platform' },
  /** A key write (generate / rotate / finish / cancel / revoke) on an org in inherit mode. */
  RUNNER_KEY_INHERITED: { httpStatus: 409, retryable: false, category: 'platform' },
  /** A key-mode change on a root org (root orgs are always `own`). */
  RUNNER_KEY_MODE_ROOT_ORG: { httpStatus: 409, retryable: false, category: 'platform' },
  /** Revoke: the typed confirmation is not the last {@link RUNNER_KEY_REVOKE_CONFIRM_CHARS} characters of the active kid. */
  RUNNER_KEY_CONFIRMATION_MISMATCH: { httpStatus: 400, retryable: false, category: 'platform' },
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
  /**
   * Anything unexpected inside the runner, or a reply the platform can't use
   * (an unknown code, a non-JSON 4xx). Final: a runner's own 4xx reply fails
   * the request. The runner answers it with a bare 500, which — like every
   * 5xx — the dispatcher retries as a transport failure (`http_5xx`), not by
   * this code.
   */
  RUNNER_ERROR: { httpStatus: 500, retryable: false, category: 'runner' },
  // -- Recorded by the platform --
  /** Not delivered within the request's lifetime. */
  RUN_REQUEST_EXPIRED: { httpStatus: null, retryable: false, category: 'recorded' },
  /** A discovery probe that found nothing (probe rows only). */
  NO_MATCH: { httpStatus: null, retryable: false, category: 'recorded' },
  /**
   * The runner a queued request was routed to is no longer one its org may use
   * (an ancestor's runner un-shared from teams, or the team moved under another
   * parent): re-checked just before delivery, the request fails instead of
   * being sent, and the pipeline's stale link is cleared (the next run
   * rediscovers).
   */
  RUNNER_NOT_ELIGIBLE: { httpStatus: null, retryable: false, category: 'recorded' },
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

// -----------------------------------------------------------------------------
// Per-org signing keys
// -----------------------------------------------------------------------------

/**
 * A signing key's lifecycle (`pipeline_runner_signing_keys.state`):
 *  - `next`     — published in the JWKS, not signing yet (signs from `activates_at`);
 *  - `active`   — signs every run request of the org (at most one per org);
 *  - `retiring` — published only, until `retire_after`;
 *  - `retired`  — gone from the JWKS; the row is kept for audit with its private key wiped.
 * At most one `next`, one `active` and one `retiring` per org (partial unique indexes).
 */
export const RUNNER_KEY_STATES = ['next', 'active', 'retiring', 'retired'] as const;
export type RunnerKeyState = (typeof RUNNER_KEY_STATES)[number];

/** The states a JWKS publishes (everything but `retired`). */
export const PUBLISHED_RUNNER_KEY_STATES = ['next', 'active', 'retiring'] as const satisfies readonly RunnerKeyState[];
export type PublishedRunnerKeyState = (typeof PUBLISHED_RUNNER_KEY_STATES)[number];

/** Why a key became `retired` (`pipeline_runner_signing_keys.retired_reason`). */
export const RUNNER_KEY_RETIRED_REASONS = ['finished', 'revoked', 'cancelled', 'mode_switch'] as const;
export type RunnerKeyRetiredReason = (typeof RUNNER_KEY_RETIRED_REASONS)[number];

/**
 * An org's key mode (`pipeline_runner_key_settings.mode`). `own`: the org signs
 * with its own keys. `inherit`: with its nearest `own` ancestor's. A missing
 * settings row means `inherit` for a sub-organization and `own` for a root org;
 * a root org is always `own`.
 */
export const RUNNER_KEY_MODES = ['inherit', 'own'] as const;
export type RunnerKeyMode = (typeof RUNNER_KEY_MODES)[number];

/** Where an org's own keys are in a rotation: none, a `next` key waiting to sign, or a `retiring` key still published. */
export const RUNNER_KEY_ROTATION_STATES = ['none', 'pending', 'overlap'] as const;
export type RunnerKeyRotationState = (typeof RUNNER_KEY_ROTATION_STATES)[number];

/** What a key-mode transition is (`pipeline_runner_key_settings.transition_kind`). */
export const RUNNER_KEY_TRANSITION_KINDS = ['to_own', 'to_inherit', 'ancestry'] as const;
export type RunnerKeyTransitionKind = (typeof RUNNER_KEY_TRANSITION_KINDS)[number];

/** A rotated-in `next` key starts signing this long after it is created (covers the runner's 10-minute JWKS cache and the route's 60 s cache). */
export const RUNNER_KEY_ACTIVATION_DELAY_MS = 10 * 60_000;
/** A key stays published (`retiring`) this long after it stops signing. */
export const RUNNER_KEY_RETIRE_WINDOW_MS = 60 * 60_000;
/** Each replica's decrypted-key cache re-checks the org's key version this often (the pub/sub backstop). */
export const RUNNER_KEY_CACHE_MS = 60_000;
/** The per-runner JWKS response is cached this long (`Cache-Control: public, max-age=60`, and server-side). */
export const RUNNER_JWKS_CACHE_SECONDS = 60;
/** Per-runner-id limit on the public JWKS route. */
export const RUNNER_JWKS_REQUESTS_PER_MINUTE = 10;
/** The per-IP backstop on the public JWKS route (generous: Lambdas share AWS egress addresses). */
export const RUNNER_JWKS_IP_REQUESTS_PER_MINUTE = 600;
/** Key writes (generate, rotate, cancel, finish, revoke, mode) per org per hour. */
export const RUNNER_KEY_WRITES_PER_HOUR = 5;
/** Revoke's typed confirmation: the last this-many characters of the active key id. */
export const RUNNER_KEY_REVOKE_CONFIRM_CHARS = 6;
/** The second age reminder is sent this many days after the first (which is sent at RUNNER_KEY_MAX_AGE_DAYS). */
export const RUNNER_KEY_AGE_FOLLOWUP_DAYS = 30;

/** The typed confirmation revoke requires for `kid`. */
export function runnerKeyRevokeConfirmation(kid: string): string {
  return kid.slice(-RUNNER_KEY_REVOKE_CONFIRM_CHARS);
}

/** Whole days from `since` to `now` (never negative; 0 when either date is unparseable). */
export function runnerKeyAgeDays(since: Date | string, now: Date | number = Date.now()): number {
  const from = typeof since === 'string' ? Date.parse(since) : since.getTime();
  const to = typeof now === 'number' ? now : now.getTime();
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.floor((to - from) / 86_400_000)) : 0;
}

// -----------------------------------------------------------------------------
// Runner link (pipeline_registry.runner_link_status)
// -----------------------------------------------------------------------------

/**
 * How a pipeline is linked to a runner:
 *  - `linked`    — `runner_id` is set (exactly one match, or a verified run);
 *  - `unlinked`  — never probed (a new registry row);
 *  - `not_found` — the last probe matched no runner (or the org has none);
 *  - `ambiguous` — the last probe matched two runners at the same level;
 *  - `checking`  — a probe is running.
 * A refresh that does not end in a single match keeps the old `runner_id` and
 * records its result in the detail; the status then names that result.
 */
export const RUNNER_LINK_STATUSES = ['linked', 'unlinked', 'not_found', 'ambiguous', 'checking'] as const;
export type RunnerLinkStatus = (typeof RUNNER_LINK_STATUSES)[number];

/** `pipeline_registry.runner_link_detail` — runner LABELS only, never an account id or a URL. */
export interface RunnerLinkDetail {
  /** Labels of the runners the last probe asked. */
  runnersChecked: string[];
  /** Labels of the runners that matched (two or more = ambiguous). */
  matched: string[];
  /** The code that ended the last probe without a single match (NO_RUNNER, AMBIGUOUS_RUNNER, PIPELINE_NOT_FOUND_IN_RUNNERS, …), else null. */
  errorCode: RunnerErrorCode | null;
}

/** Link-refresh requests per org per minute. */
export const RUNNER_LINK_REFRESHES_PER_MINUTE = 5;

// -----------------------------------------------------------------------------
// Health and tunable limits
// -----------------------------------------------------------------------------

/** Consecutive failed deliveries that mark a runner unreachable. */
export const UNREACHABLE_AFTER_FAILURES = 3;

/**
 * Each tunable runner limit's env name and default, as the env string a deploy
 * target declares (the deploy-contracts suite can read this literal). The
 * pipeline service parses them; each must be a whole number >= its minimum in
 * {@link RUNNER_TUNABLE_MINIMUMS}, else the default applies.
 *  - RUN_REQUESTS_PER_MINUTE — user start/stop requests per pipeline per minute;
 *  - MAX_PENDING_PER_ORG — pending (queued|delivering) user-initiated requests per org (429 TOO_MANY_PENDING above it; system-initiated runs queue past it);
 *  - MAX_IN_FLIGHT_PER_RUNNER — deliveries in flight to one runner;
 *  - RUNNER_HEALTH_PING_INTERVAL_SECONDS — every active runner is pinged this often;
 *  - RUNNER_UNHEALTHY_AFTER_PINGS — consecutive failed pings that mark it unreachable (a SIGNATURE_INVALID or RUNNER_REFUSED reply does at once);
 *  - RUNNER_KEY_MAX_AGE_DAYS — an active key this old earns an age reminder (and the badge).
 */
export const RUNNER_TUNABLE_DEFAULTS = {
  RUN_REQUESTS_PER_MINUTE: '6',
  MAX_PENDING_PER_ORG: '500',
  MAX_IN_FLIGHT_PER_RUNNER: '8',
  RUNNER_HEALTH_PING_INTERVAL_SECONDS: '60',
  RUNNER_UNHEALTHY_AFTER_PINGS: '2',
  RUNNER_KEY_MAX_AGE_DAYS: '365',
} as const;
export type RunnerTunableEnv = keyof typeof RUNNER_TUNABLE_DEFAULTS;

/** The smallest value each tunable accepts. */
export const RUNNER_TUNABLE_MINIMUMS: Readonly<Record<RunnerTunableEnv, number>> = {
  RUN_REQUESTS_PER_MINUTE: 1,
  MAX_PENDING_PER_ORG: 1,
  MAX_IN_FLIGHT_PER_RUNNER: 1,
  RUNNER_HEALTH_PING_INTERVAL_SECONDS: 10,
  RUNNER_UNHEALTHY_AFTER_PINGS: 1,
  RUNNER_KEY_MAX_AGE_DAYS: 1,
};

/** The bad values each warning sink was already told about (settings are re-read per request: warn once). */
const tunableWarned = new WeakMap<(message: string) => void, Set<string>>();

// eslint-disable-next-line no-console
const consoleWarn = (message: string): void => console.warn(message);

/**
 * Read one tunable from `env`: a whole number written in digits only
 * (`/^\d+$/` after trimming) at or above its minimum. Unset or blank is the
 * default; anything else (a fraction, sign, exponent, hex, unit, or a value
 * below the minimum) is the default too, with one `warn` per distinct value.
 */
export function runnerTunable(name: RunnerTunableEnv, env: Readonly<Record<string, string | undefined>>, warn: (message: string) => void = consoleWarn): number {
  const fallback = Number(RUNNER_TUNABLE_DEFAULTS[name]);
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(n) && n >= RUNNER_TUNABLE_MINIMUMS[name]) return n;
  let seen = tunableWarned.get(warn);
  if (!seen) tunableWarned.set(warn, (seen = new Set()));
  const key = `${name}=${raw}`;
  if (!seen.has(key)) {
    seen.add(key);
    warn(`${name}=${JSON.stringify(raw)} is not a whole number of at least ${RUNNER_TUNABLE_MINIMUMS[name]} (digits only); using the default ${fallback}.`);
  }
  return fallback;
}

// -----------------------------------------------------------------------------
// Cache invalidation (Redis pub/sub)
// -----------------------------------------------------------------------------

/** The Redis pub/sub channel every pipeline replica subscribes to for key and pause changes. */
export const RUNNER_KEY_INVALIDATION_CHANNEL = 'runner-keys:invalidate';

/**
 * One invalidation message (JSON on {@link RUNNER_KEY_INVALIDATION_CHANNEL}),
 * published after the change COMMITS. Never carries key material.
 *  - `keys`  — drop the signer and JWKS cache entries of every org in `orgIds`
 *              (the changed org plus every descendant whose effective key org it is);
 *  - `pause` — the platform pause toggle changed; re-read it.
 */
export type RunnerKeyInvalidation =
  | { v: 1; kind: 'keys'; origin: string; orgIds: string[] }
  | { v: 1; kind: 'pause'; origin: string; paused: boolean };

/** Parse one channel message; null for anything malformed (ignored by subscribers). */
export function parseRunnerKeyInvalidation(raw: string): RunnerKeyInvalidation | null {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.v !== 1 || typeof o.origin !== 'string') return null;
  if (o.kind === 'keys' && Array.isArray(o.orgIds) && o.orgIds.every((x) => typeof x === 'string')) {
    return { v: 1, kind: 'keys', origin: o.origin, orgIds: o.orgIds as string[] };
  }
  if (o.kind === 'pause' && typeof o.paused === 'boolean') return { v: 1, kind: 'pause', origin: o.origin, paused: o.paused };
  return null;
}

// -----------------------------------------------------------------------------
// Metrics
// -----------------------------------------------------------------------------

/** Metric names the key store, the sweep and the alert rules share. */
export const RUNNER_KEY_METRICS = {
  /** Gauge `{state}`: key rows per state across the deployment (retired included). */
  keys: 'pipeline_runner_signing_keys',
  /** Gauge: age in days of the OLDEST active key (no org label). */
  ageDays: 'pipeline_runner_signing_key_age_days',
  /** Gauge: active keys older than RUNNER_KEY_MAX_AGE_DAYS. */
  overAge: 'pipeline_runner_signing_keys_over_age',
  /** Gauge: orgs whose effective key could not be decrypted at the last attempt (the operator alert). */
  unreadable: 'pipeline_runner_signing_keys_unreadable',
  /** Counter `{source}`: cache entries dropped, source `pubsub` | `poll`. */
  invalidations: 'pipeline_runner_signing_key_invalidations_total',
} as const;

// -----------------------------------------------------------------------------
// DTOs (HTTP bodies; dates are ISO strings)
// -----------------------------------------------------------------------------

/** One of an org's published keys. Never key material: id, state and dates only. */
export interface RunnerSigningKeySummary {
  /** RFC 7638 thumbprint (the JWK `kid`). */
  kid: string;
  state: PublishedRunnerKeyState;
  createdAt: string;
  /** User id of whoever created it (the registering user for an auto-created first key); null when unknown. */
  createdBy: string | null;
  /** `next`: when it starts signing. `active` / `retiring`: when it started signing. */
  activatesAt: string;
  /** `retiring` only: when it leaves the JWKS (and Finish now is allowed). */
  retireAfter: string | null;
  /** Whole days since `activatesAt` (0 for `next`). */
  ageDays: number;
}

/** `signingKey` on `GET /pipelines/runners`. */
export interface RunnerSigningKeyDto {
  mode: RunnerKeyMode;
  /** True for a root org (always `own`; no mode switch). */
  isRootOrg: boolean;
  /** This org's OWN keys (all null in inherit mode outside a transition). */
  active: RunnerSigningKeySummary | null;
  next: RunnerSigningKeySummary | null;
  retiring: RunnerSigningKeySummary | null;
  rotation: RunnerKeyRotationState;
  /** In inherit mode: the effective key org (nearest `own` ancestor). Null in own mode. */
  inheritedFrom: { orgId: string; orgName: string; activeKid: string | null; rotation: RunnerKeyRotationState } | null;
  /** Descendant teams whose effective key org is this org (a parent's card: "Used by 3 teams"). */
  inheritingTeams: number;
  /** Their names, for the rotate / revoke / mode dialogs. */
  inheritingTeamNames: string[];
  /** Runners (own + those teams') that verify with this org's keys. */
  inheritingRunners: number;
  /** A mode switch or ancestry change in progress, else null. */
  transition: { kind: RunnerKeyTransitionKind; switchAt: string; until: string } | null;
  /** The effective key cannot be decrypted: no actions, the operator must fix it. */
  unreadable: boolean;
  /** RUNNER_KEY_MAX_AGE_DAYS as configured (the badge threshold). */
  maxAgeDays: number;
}

/** Where a {@link RunnerKeyServiceUnavailableError} came from: the org's KMS config lookup, or KMS itself. */
export const RUNNER_KEY_SERVICE_SOURCES = ['kms_config', 'kms'] as const;
export type RunnerKeyServiceSource = (typeof RUNNER_KEY_SERVICE_SOURCES)[number];

/**
 * A signing key could not be USED for a reason that is not the key: the
 * per-org KMS config lookup (platform) failed, or KMS could not be reached
 * (network, throttling, a 5xx). Transient — it says nothing about the stored
 * ciphertext, so it is never RUNNER_KEY_UNREADABLE (no unreadable gauge, no
 * operator notice): the caller answers 409 RUNNERS_UNAVAILABLE and a queued
 * request stays queued. Only a real decrypt failure of the ciphertext (wrong
 * master, tampered or wrong-org blob, a KMS key that refuses it) is
 * RUNNER_KEY_UNREADABLE.
 */
export class RunnerKeyServiceUnavailableError extends Error {
  /** The catalog code this maps to. */
  readonly code = 'RUNNERS_UNAVAILABLE' as const satisfies RunnerApiErrorCode;
  /** The unavailable reason it answers with (`details.reason`): never the operator pause. */
  readonly reason = 'key_service' as const satisfies RunnersUnavailableReason;

  constructor(readonly source: RunnerKeyServiceSource, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunnerKeyServiceUnavailableError';
  }
}

/** Whether `err` is a {@link RunnerKeyServiceUnavailableError} (by name too: bundles may carry their own copy of the class). */
export function isRunnerKeyServiceUnavailable(err: unknown): err is RunnerKeyServiceUnavailableError {
  return err instanceof RunnerKeyServiceUnavailableError
    || (err instanceof Error && err.name === 'RunnerKeyServiceUnavailableError' && (err as { code?: unknown }).code === 'RUNNERS_UNAVAILABLE');
}

/**
 * Why runners are unavailable (`available: false`, and `details.reason` of a
 * 409 RUNNERS_UNAVAILABLE): `paused` — the operator's pause toggle;
 * `encryption_not_configured` — the deployment is not set up; `key_service` — a transient key-service failure (the org's KMS config
 * lookup or KMS itself, {@link RunnerKeyServiceUnavailableError}) while
 * resolving a signing key: queued runs retry on their own. Only the first
 * two are ever a deployment-wide `available: false`.
 */
export const RUNNERS_UNAVAILABLE_REASONS = ['paused', 'encryption_not_configured', 'key_service'] as const;
export type RunnersUnavailableReason = (typeof RUNNERS_UNAVAILABLE_REASONS)[number];

/** One runner on `GET /pipelines/runners`. Never an AWS account id. */
export interface PipelineRunnerDto {
  id: string;
  orgId: string;
  label: string;
  /** Only for the OWNING org's admins (null everywhere else). A secret. */
  functionUrl: string | null;
  shareWithTeams: boolean;
  version: string | null;
  regions: string[];
  health: RunnerHealth;
  status: RunnerStatus;
  lastDeliveryAt: string | null;
  createdAt: string;
  updateRequired: boolean;
  /** Absolute: PLATFORM_BASE_URL + {@link runnerJwksPath}(id). */
  jwksUrl: string;
  /** Pipelines linked to this runner (`pipeline_registry.runner_id`). */
  pipelineCount: number;
}

/** A parent org's runner shared with this team (signed with the parent's effective key). */
export interface InheritedPipelineRunnerDto extends PipelineRunnerDto {
  fromOrgId: string;
  fromOrgName: string;
}

/** `GET /pipelines/runners`. */
export interface PipelineRunnersListDto {
  available: boolean;
  unavailableReason: RunnersUnavailableReason | null;
  platformEgressIps: string[] | null;
  own: PipelineRunnerDto[];
  inherited: InheritedPipelineRunnerDto[];
  /** Null while runners are unavailable. */
  signingKey: RunnerSigningKeyDto | null;
}

/** `GET /pipelines/:pipelineId/runner-link` (and the 202 of `POST …/runner-link/refresh`, with `status: 'checking'`). */
export interface RunnerLinkDto {
  pipelineId: string;
  status: RunnerLinkStatus;
  /**
   * The linked runner, when `runner_id` is set (it may be kept through a failed refresh).
   * `isOwn`: the caller's org owns it (false for an ancestor's shared runner) — what
   * decides "shared by …" and the Test action, never inferred from `ownerOrgName`.
   * `ownerOrgName` is set for every runner that is not the caller's own.
   */
  runner: { id: string; label: string; health: RunnerHealth; lastDeliveryAt: string | null; ownerOrgName: string | null; isOwn: boolean } | null;
  checkedAt: string | null;
  detail: RunnerLinkDetail | null;
  /** The platform pause toggle is on (the pipeline page's banner). */
  deliveriesPaused: boolean;
}

/** One row of `GET /pipelines/admin/runner-signing-keys` (operators). Never key material. */
export interface RunnerKeyStatusRow {
  orgId: string;
  orgName: string | null;
  mode: RunnerKeyMode;
  inheritedFrom: { orgId: string; orgName: string | null } | null;
  /** The org's own active key (null in inherit mode or before the first key). */
  activeKid: string | null;
  keyAgeDays: number | null;
  rotation: RunnerKeyRotationState;
  /** A mode switch or ancestry change is in progress. */
  inTransition: boolean;
  overAge: boolean;
  unreadable: boolean;
  /** The org's own non-revoked runners. */
  runnerCount: number;
}

/** `GET|PUT /pipelines/admin/runner-deliveries` — the platform pause toggle. */
export interface RunnerDeliveriesDto {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  reason: string | null;
}

/**
 * THE answer of Run (`POST /pipelines/:id/executions`, 202), Stop
 * (`POST /pipelines/:id/executions/:executionId/stop`, 202) and plugin-upgrade's
 * redeploy (`redeploy` of each upgraded pipeline). Poll
 * `GET /pipelines/:id/run-requests/:requestId` for progress.
 */
export interface QueuedRunRequestDto {
  requestId: string;
  status: PendingRunRequestStatus;
  runnerLabel: string;
}

/** One key the per-runner JWKS publishes. */
export interface RunnerPublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
}

/** `GET /pipelines/runner/runners/:runnerId/jwks.json`. */
export interface RunnerJwksDto {
  keys: RunnerPublicJwk[];
}
