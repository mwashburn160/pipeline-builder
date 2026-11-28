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

export const RUN_REQUEST_STATUSES = [
  'queued', 'delivering', 'started', 'stopped', 'failed', 'expired',
  // A deploy / undeploy the runner accepted: its CodeBuild job is running (`deploying` / `undeploying`),
  // then finished (`deployed` / `undeployed`), or a person cancelled it (`cancelled`).
  'deploying', 'deployed', 'cancelled', 'undeploying', 'undeployed',
] as const;
export type RunRequestStatus = (typeof RUN_REQUEST_STATUSES)[number];

/** Still waiting to be delivered. */
export const PENDING_RUN_REQUEST_STATUSES = ['queued', 'delivering'] as const satisfies readonly RunRequestStatus[];
export type PendingRunRequestStatus = (typeof PENDING_RUN_REQUEST_STATUSES)[number];

/** Delivered and accepted, a runner job still running (deploy / undeploy only): the status poll decides what follows. */
export const IN_PROGRESS_RUN_REQUEST_STATUSES = ['deploying', 'undeploying'] as const satisfies readonly RunRequestStatus[];
export type InProgressRunRequestStatus = (typeof IN_PROGRESS_RUN_REQUEST_STATUSES)[number];

/** Nothing further happens after these. */
export const TERMINAL_RUN_REQUEST_STATUSES = [
  'started', 'stopped', 'failed', 'expired', 'deployed', 'cancelled', 'undeployed',
] as const satisfies readonly RunRequestStatus[];
export type TerminalRunRequestStatus = (typeof TERMINAL_RUN_REQUEST_STATUSES)[number];

/** Whether `s` is a terminal request status (false for anything unknown). */
export function isTerminalRunRequestStatus(s: unknown): s is TerminalRunRequestStatus {
  return typeof s === 'string' && (TERMINAL_RUN_REQUEST_STATUSES as readonly string[]).includes(s);
}

/** What a signed request asks the runner to do. */
export const RUNNER_ACTIONS = ['start', 'stop', 'probe', 'ping', 'status', 'deploy', 'deploy_status', 'deploy_cancel', 'undeploy'] as const;
export type RunnerAction = (typeof RUNNER_ACTIONS)[number];

/** The actions recorded as a run request row (a `ping`, a `status` / `deploy_status` read and a `deploy_cancel` never are). */
export const RUN_REQUEST_ACTIONS = ['start', 'stop', 'probe', 'deploy', 'undeploy'] as const satisfies readonly RunnerAction[];
export type RunRequestAction = (typeof RUN_REQUEST_ACTIONS)[number];

/** A runner's successful answers (`outcome` of a 200). */
export const RUNNER_OUTCOMES = [
  'started', 'stopped', 'match', 'no_match', 'pong', 'status',
  'deploying', 'deploy_status', 'deploy_cancelled', 'undeploying',
] as const;
export type RunnerOutcome = (typeof RUNNER_OUTCOMES)[number];

/** The outcome a successful answer to each action must carry. */
export const EXPECTED_OUTCOMES: Readonly<Record<RunnerAction, readonly RunnerOutcome[]>> = {
  start: ['started'],
  stop: ['stopped'],
  probe: ['match', 'no_match'],
  ping: ['pong'],
  status: ['status'],
  deploy: ['deploying'],
  deploy_status: ['deploy_status'],
  deploy_cancel: ['deploy_cancelled'],
  undeploy: ['undeploying'],
};

// -----------------------------------------------------------------------------
// Runner capabilities (reported in a pong, stored on the runner row)
// -----------------------------------------------------------------------------

/**
 * What a runner bundle can do beyond start/stop/probe/ping/status. `deploy:1`:
 * the stack was set up with `--enable-deploy` (EnableDeploy=true) and the
 * bundle speaks deploy, deploy_status, deploy_cancel and undeploy. One
 * capability covers undeploy too: it runs the same CodeBuild project.
 */
export const RUNNER_CAPABILITIES = ['deploy:1'] as const;
export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

export const DEPLOY_CAPABILITY = 'deploy:1' as const satisfies RunnerCapability;

/**
 * The capability each gated action needs. The platform checks it BEFORE
 * signing: a bundle without it answers an unknown action 401
 * SIGNATURE_INVALID, which would page RunnerSignatureInvalid.
 */
export const DEPLOY_ACTION_CAPABILITY = {
  deploy: DEPLOY_CAPABILITY,
  deploy_status: DEPLOY_CAPABILITY,
  deploy_cancel: DEPLOY_CAPABILITY,
  undeploy: DEPLOY_CAPABILITY,
} as const satisfies Partial<Record<RunnerAction, RunnerCapability>>;

/** Whether a runner reporting `capabilities` may be sent `action`. */
export function runnerSupportsAction(capabilities: readonly string[], action: RunnerAction): boolean {
  const needed = (DEPLOY_ACTION_CAPABILITY as Partial<Record<RunnerAction, RunnerCapability>>)[action];
  return needed === undefined || capabilities.includes(needed);
}

/** A pong's `capabilities`, kept to the known ones (deduplicated, catalog order); [] for anything malformed. */
export function parseRunnerCapabilities(raw: unknown): RunnerCapability[] {
  if (!Array.isArray(raw)) return [];
  return RUNNER_CAPABILITIES.filter((c) => raw.includes(c));
}

/** One allowlisted pipeline-name prefix a runner reports: `*` or CodePipeline name characters. */
export const PIPELINE_PREFIX_PATTERN = /^(?:\*|[A-Za-z0-9.@_-]{1,100})$/;
/** At most this many prefixes are stored per runner. */
export const MAX_PIPELINE_PREFIXES = 50;

/** A pong's `pipelinePrefixes`, valid ones only (deduplicated, at most {@link MAX_PIPELINE_PREFIXES}); [] for anything malformed. */
export function parsePipelinePrefixes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = [...new Set(raw.filter((p): p is string => typeof p === 'string' && PIPELINE_PREFIX_PATTERN.test(p)))];
  return out.slice(0, MAX_PIPELINE_PREFIXES);
}

/** Whether the runner's prefix allowlist covers `pipelineName` (as the runner's own check does; none reported = no match). */
export function pipelineNameMatchesPrefixes(pipelineName: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => p === '*' || pipelineName.startsWith(p));
}

/** An AWS region name (`us-east-1`, `us-gov-west-1`). */
export const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/**
 * The details of a `pong` (beside `outcome`), as a runner sends them — raw:
 * parse `capabilities` / `pipelinePrefixes` with {@link parseRunnerCapabilities}
 * / {@link parsePipelinePrefixes} before storing them.
 */
export interface RunnerPongDetails {
  regions?: unknown;
  runnerVersion?: unknown;
  capabilities?: unknown;
  pipelinePrefixes?: unknown;
}

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
  // -- Deploys through a runner (the pipeline service's answers) --
  /** The runner does not list the `deploy:1` capability (an old bundle, or a stack without --enable-deploy): update it with {@link DEPLOY_SETUP_COMMAND}. */
  RUNNER_DEPLOY_UNSUPPORTED: { httpStatus: 409, retryable: false, category: 'platform' },
  /** Several runners can deploy this pipeline and none was named (`details.runners`: the deployable ones). */
  DEPLOY_RUNNER_REQUIRED: { httpStatus: 409, retryable: false, category: 'platform' },
  /** The runner named (or the only one) cannot deploy this pipeline (`details.reason`: a {@link DeployTargetReason}). */
  RUNNER_NOT_DEPLOYABLE: { httpStatus: 409, retryable: false, category: 'platform' },
  /** The pipeline already has a registry row: deploys through a runner are for a never-deployed pipeline only. */
  ALREADY_DEPLOYED: { httpStatus: 409, retryable: false, category: 'platform' },
  /**
   * Another deploy of this pipeline is active (`details.requestId`). Also what a
   * runner answers when its project already builds this pipeline for another
   * request id (the one platform code a runner may send: final, like any 4xx).
   */
  DEPLOY_IN_PROGRESS: { httpStatus: 409, retryable: false, category: 'platform' },
  /** The region asked for is not one of the runner's allowed regions (or several are and none was named). */
  DEPLOY_REGION_NOT_ALLOWED: { httpStatus: 409, retryable: false, category: 'platform' },
  /** The pipeline's pinned toolchain release ships no cdk-synth image speaking {@link DEPLOY_JOB_PROTOCOL_VERSION}. */
  TOOLCHAIN_TOO_OLD_FOR_DEPLOY: { httpStatus: 409, retryable: false, category: 'platform' },
  /** Cancel of a deploy that already finished. */
  DEPLOY_NOT_CANCELLABLE: { httpStatus: 409, retryable: false, category: 'platform' },
  /** DEPLOY_REQUESTS_PER_HOUR for the org. */
  DEPLOY_RATE_LIMITED: { httpStatus: 429, retryable: false, category: 'platform' },
  /** MAX_ACTIVE_DEPLOYS_PER_RUNNER deploys already active on the runner. */
  TOO_MANY_DEPLOYS: { httpStatus: 429, retryable: false, category: 'platform' },
  /** The deploy job's grant (or session) was refused (`details.reason`: a {@link DeployGrantRejectionReason}). */
  DEPLOY_GRANT_INVALID: { httpStatus: 401, retryable: false, category: 'platform' },
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
  // -- A runner's answers to the deploy actions --
  /** The stack was not set up with --enable-deploy (the platform clears the runner's stored capabilities). */
  DEPLOY_NOT_ENABLED: { httpStatus: 403, retryable: false, category: 'runner' },
  /** A pipeline tagged with this pipeline id already exists in the account (the platform links it instead). */
  PIPELINE_ALREADY_DEPLOYED: { httpStatus: 409, retryable: false, category: 'runner' },
  /** The deploy project is at its concurrent build limit (delivered again). */
  DEPLOY_BUSY: { httpStatus: 409, retryable: true, category: 'runner' },
  /** deploy_status / deploy_cancel: no such build in the runner's own deploy project. */
  DEPLOY_BUILD_NOT_FOUND: { httpStatus: 404, retryable: false, category: 'runner' },
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
  /** deploy and undeploy only: what the runner's CodeBuild job runs. */
  deploy?: RunDeployClaim;
  /** deploy_status and deploy_cancel only: the deploy / undeploy request whose build is asked about (its `jti`). */
  deployRequestId?: string;
  /** deploy_status and deploy_cancel only: the build the runner answered `deploying` / `undeploying` with. */
  buildId?: string;
  requestedBy: string;
}

/**
 * The `deploy` claim block (actions `deploy` and `undeploy`). The runner
 * validates every field, KMS-encrypts `grant` under
 * {@link deployGrantEncryptionContext} and hands the job only that ciphertext
 * ({@link DEPLOY_JOB_ENV}.grantCiphertext): the cleartext grant never reaches
 * a CodeBuild env override (visible to BatchGetBuilds and CloudTrail).
 */
export interface RunDeployClaim {
  /** The single-use job grant ({@link DEPLOY_GRANT_PATTERN}). Never logged. */
  grant: string;
  /** {@link DEPLOY_JOB_PROTOCOL_VERSION} as the platform speaks it; the job refuses to run on a mismatch. */
  protocol: number;
  mode: DeployJobMode;
  region: string;
  /** The CodePipeline name (pipeline-core `deployedPipelineNames`). */
  pipelineName: string;
  /** The CloudFormation stack name (pipeline-core `deployedPipelineNames`). */
  stackName: string;
  /** The managed cdk-synth image of the pipeline's toolchain release, pinned by digest; the host is the runner stack's. */
  image: { repository: typeof DEPLOY_JOB_IMAGE_REPOSITORY; digest: string };
  /** The managed toolchain release that image belongs to. */
  toolchainRelease: string;
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
 *  - RUNNER_KEY_MAX_AGE_DAYS — an active key this old earns an age reminder (and the badge);
 *  - DEPLOY_REQUESTS_PER_HOUR — deploys through a runner per org per hour (429 DEPLOY_RATE_LIMITED);
 *  - MAX_ACTIVE_DEPLOYS_PER_RUNNER — active (queued|delivering|deploying) deploys per runner (429 TOO_MANY_DEPLOYS);
 *  - RUNNER_DEPLOY_DEADLINE_MINUTES — an accepted deploy past this is cancelled and fails DEPLOY_TIMED_OUT;
 *  - RUNNER_DEPLOY_STATUS_POLL_SECONDS — each deploying request's build is polled (signed deploy_status) this often.
 */
export const RUNNER_TUNABLE_DEFAULTS = {
  RUN_REQUESTS_PER_MINUTE: '6',
  MAX_PENDING_PER_ORG: '500',
  MAX_IN_FLIGHT_PER_RUNNER: '8',
  RUNNER_HEALTH_PING_INTERVAL_SECONDS: '60',
  RUNNER_UNHEALTHY_AFTER_PINGS: '2',
  RUNNER_KEY_MAX_AGE_DAYS: '365',
  DEPLOY_REQUESTS_PER_HOUR: '20',
  MAX_ACTIVE_DEPLOYS_PER_RUNNER: '2',
  RUNNER_DEPLOY_DEADLINE_MINUTES: '120',
  RUNNER_DEPLOY_STATUS_POLL_SECONDS: '30',
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
  DEPLOY_REQUESTS_PER_HOUR: 1,
  MAX_ACTIVE_DEPLOYS_PER_RUNNER: 1,
  RUNNER_DEPLOY_DEADLINE_MINUTES: 15,
  RUNNER_DEPLOY_STATUS_POLL_SECONDS: 10,
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
// Deploys through a runner (actions deploy / deploy_status / deploy_cancel / undeploy)
// -----------------------------------------------------------------------------

/** The statuses of a `deploy` request row. */
export const DEPLOY_REQUEST_STATUSES = ['queued', 'delivering', 'deploying', 'deployed', 'failed', 'expired', 'cancelled'] as const satisfies readonly RunRequestStatus[];
export type DeployRequestStatus = (typeof DEPLOY_REQUEST_STATUSES)[number];

/** The statuses of an `undeploy` request row (sent by the platform on purge; nobody cancels one). */
export const UNDEPLOY_REQUEST_STATUSES = ['queued', 'delivering', 'undeploying', 'undeployed', 'failed', 'expired'] as const satisfies readonly RunRequestStatus[];
export type UndeployRequestStatus = (typeof UNDEPLOY_REQUEST_STATUSES)[number];

/** A deploy in one of these is THE active deploy of its pipeline (partial unique index `pipeline_run_requests_one_active_deploy_uq`). */
export const ACTIVE_DEPLOY_STATUSES = ['queued', 'delivering', 'deploying'] as const satisfies readonly DeployRequestStatus[];
export type ActiveDeployStatus = (typeof ACTIVE_DEPLOY_STATUSES)[number];

/**
 * Where the deploy job is (the job's progress posts and its exported
 * PB_DEPLOY_STAGE; `queued` until the build starts). `cleaning`: deleting this
 * pipeline's own never-completed first stack (ROLLBACK_COMPLETE / DELETE_FAILED)
 * before deploying again. `removing`: an undeploy deleting the stack.
 */
export const DEPLOY_STAGES = [
  'queued', 'starting', 'authenticating', 'fetching', 'prechecking', 'cleaning', 'synthesizing', 'deploying', 'registering', 'removing', 'done',
] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

/** A deploy build's state as a runner reports it (CodeBuild's BuildStatus, normalized). */
export const DEPLOY_BUILD_STATES = ['in_progress', 'succeeded', 'failed', 'stopped', 'timed_out'] as const;
export type DeployBuildState = (typeof DEPLOY_BUILD_STATES)[number];

const CODEBUILD_BUILD_STATES: Readonly<Record<string, DeployBuildState>> = {
  IN_PROGRESS: 'in_progress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  FAULT: 'failed',
  STOPPED: 'stopped',
  TIMED_OUT: 'timed_out',
};

/** CodeBuild's `buildStatus` → {@link DeployBuildState}: absent is still running, an unknown final status is `failed`. */
export function deployBuildState(codebuildStatus: string | null | undefined): DeployBuildState {
  if (!codebuildStatus) return 'in_progress';
  return Object.hasOwn(CODEBUILD_BUILD_STATES, codebuildStatus) ? CODEBUILD_BUILD_STATES[codebuildStatus]! : 'failed';
}

/** What kind of thing made a deploy fail — what the dashboard's next steps are keyed by. */
export const DEPLOY_FAILURE_CLASSES = ['account_setup', 'definition', 'aws_permission', 'cloudformation', 'image', 'platform', 'timeout', 'cancelled', 'unknown'] as const;
export type DeployFailureClass = (typeof DEPLOY_FAILURE_CLASSES)[number];

export interface RunnerDeployErrorMeta {
  readonly class: DeployFailureClass;
  /** Sending the same pipeline again (Retry / Change runner) can succeed without editing the pipeline. */
  readonly retryable: boolean;
}

/**
 * Every deploy RESULT code: the job's (its result post and exported
 * PB_DEPLOY_RESULT) and the platform's own (grant refusals, deadline, cancel).
 * Recorded as a deploy request's `errorCode`; never an HTTP answer (those are
 * {@link RUNNER_ERRORS}), and no code is in both catalogs.
 */
export const RUNNER_DEPLOY_ERRORS = {
  /** The job's grant exchange was refused (reused, unknown, wrong state). */
  DEPLOY_GRANT_REJECTED: { class: 'platform', retryable: false },
  /** The grant expired before the job exchanged it ({@link DEPLOY_GRANT_TTL_MS}): the build queued too long. */
  DEPLOY_GRANT_EXPIRED: { class: 'platform', retryable: true },
  /** The job could not read the pipeline through its session. */
  PIPELINE_FETCH_FAILED: { class: 'platform', retryable: true },
  /** A plugin of the pipeline did not resolve (lookup through the session). */
  PLUGIN_RESOLUTION_FAILED: { class: 'definition', retryable: false },
  /** The synthesized pipeline / stack names or region are not the ones the request named. */
  DEPLOY_TARGET_MISMATCH: { class: 'definition', retryable: false },
  /** A stack of that name exists and is not this pipeline's (tagged for another pipeline, or untagged). */
  STACK_OWNED_BY_OTHER_PIPELINE: { class: 'definition', retryable: false },
  /** The target region has no CDK bootstrap (`pipeline-manager bootstrap --region <r>`). */
  CDK_NOT_BOOTSTRAPPED: { class: 'account_setup', retryable: true },
  /** The region's CDK bootstrap is older than the toolchain needs. */
  CDK_BOOTSTRAP_OUTDATED: { class: 'account_setup', retryable: true },
  /** Secrets the pipeline needs are not in the account's Secrets Manager. */
  ACCOUNT_SECRETS_MISSING: { class: 'account_setup', retryable: true },
  /** A bootstrap role refused an AWS call (or the permissions boundary did). */
  DEPLOY_PERMISSION_DENIED: { class: 'aws_permission', retryable: true },
  /** `cdk deploy` failed in CloudFormation. */
  CFN_DEPLOY_FAILED: { class: 'cloudformation', retryable: true },
  /** Deleting this pipeline's stack (cleaning a failed first deploy, or an undeploy) did not reach DELETE_COMPLETE. */
  STACK_DELETE_FAILED: { class: 'cloudformation', retryable: true },
  /** CodeBuild could not pull the cdk-synth image (registry credential or host). */
  DEPLOY_IMAGE_PULL_FAILED: { class: 'image', retryable: true },
  /** The image's deploy-job protocol is not the claim's ({@link DEPLOY_JOB_PROTOCOL_VERSION}). */
  DEPLOY_JOB_PROTOCOL_MISMATCH: { class: 'image', retryable: false },
  /**
   * The synthesized stack has Docker image assets: the deploy build is never
   * privileged (no such mode exists on the runner), so a retry fails the same
   * way. A runtime guard — the stacks this product synthesizes carry none.
   */
  DEPLOY_NEEDS_PRIVILEGED: { class: 'image', retryable: false },
  /** Past RUNNER_DEPLOY_DEADLINE_MINUTES, or CodeBuild's own timeout. */
  DEPLOY_TIMED_OUT: { class: 'timeout', retryable: true },
  /** A person cancelled it. */
  DEPLOY_CANCELLED: { class: 'cancelled', retryable: true },
  /** Anything else inside the job. */
  DEPLOY_JOB_ERROR: { class: 'unknown', retryable: true },
} as const satisfies Record<string, RunnerDeployErrorMeta>;

export type RunnerDeployErrorCode = keyof typeof RUNNER_DEPLOY_ERRORS;
export const RUNNER_DEPLOY_ERROR_CODES = Object.keys(RUNNER_DEPLOY_ERRORS) as readonly RunnerDeployErrorCode[];

/** Whether `code` is a known deploy result error code. */
export function isRunnerDeployErrorCode(code: unknown): code is RunnerDeployErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(RUNNER_DEPLOY_ERRORS, code);
}

/** The job's success result. */
export const DEPLOY_RESULT_OK = 'OK';
/** Everything a job may report as its result (PB_DEPLOY_RESULT / POST result): a fixed list — never a message, log line or ARN. */
export const DEPLOY_JOB_RESULT_CODES = [DEPLOY_RESULT_OK, ...RUNNER_DEPLOY_ERROR_CODES] as const;
export type DeployJobResultCode = typeof DEPLOY_RESULT_OK | RunnerDeployErrorCode;

export function isDeployJobResultCode(code: unknown): code is DeployJobResultCode {
  return code === DEPLOY_RESULT_OK || isRunnerDeployErrorCode(code);
}

/** Any code a failed deploy request may record: a deploy result code or a runner catalog code (delivery, refusal). */
export type DeployErrorCode = RunnerDeployErrorCode | RunnerErrorCode;

/** Runner answers that mean the account's runner setup refused the deploy (fixable there). */
const ACCOUNT_SETUP_RUNNER_CODES: readonly string[] = ['DEPLOY_NOT_ENABLED', 'RUNNER_REFUSED', 'RUNNER_PERMISSION_DENIED', 'RUNNER_DEPLOY_UNSUPPORTED'];

/**
 * A failed deploy's class and retryability from its recorded code: the
 * deploy catalog's own; a runner refusal of the setup is `account_setup`; a
 * pipeline already in the runner's account is `account_setup` and not
 * retryable (the platform registers that pipeline instead, so a Retry only
 * answers ALREADY_DEPLOYED); any other runner catalog code (not delivered, bad
 * signature, …) `platform`; an unknown code `unknown`. Null for no code.
 */
export function deployFailureOf(code: string | null | undefined): { failureClass: DeployFailureClass; retryable: boolean } | null {
  if (!code) return null;
  if (isRunnerDeployErrorCode(code)) return { failureClass: RUNNER_DEPLOY_ERRORS[code].class, retryable: RUNNER_DEPLOY_ERRORS[code].retryable };
  if (code === 'PIPELINE_ALREADY_DEPLOYED') return { failureClass: 'account_setup', retryable: false };
  if (ACCOUNT_SETUP_RUNNER_CODES.includes(code)) return { failureClass: 'account_setup', retryable: true };
  if (isRunnerErrorCode(code)) return { failureClass: 'platform', retryable: true };
  return { failureClass: 'unknown', retryable: true };
}

/** Why a grant exchange was refused (`details.reason` of 401 DEPLOY_GRANT_INVALID; the rejections metric's `reason` label). */
export const DEPLOY_GRANT_REJECTION_REASONS = ['reused', 'expired', 'unknown', 'wrong_state'] as const;
export type DeployGrantRejectionReason = (typeof DEPLOY_GRANT_REJECTION_REASONS)[number];

// ---- Grant and session tokens ----

/** A deploy job grant: this prefix + 32 random bytes, base64url (single use, minted at queue time; only its sha256 is stored in clear). */
export const DEPLOY_GRANT_PREFIX = 'pb_dg_';
/** A deploy session token: this prefix + 32 random bytes, base64url (opaque; body only; valid to the deploy deadline). */
export const DEPLOY_SESSION_PREFIX = 'pb_ds_';
/** Random bytes in a grant / session token. */
export const DEPLOY_TOKEN_RANDOM_BYTES = 32;
export const DEPLOY_GRANT_PATTERN = /^pb_dg_[A-Za-z0-9_-]{43}$/;
export const DEPLOY_SESSION_PATTERN = /^pb_ds_[A-Za-z0-9_-]{43}$/;

/** The deploy project's QueuedTimeoutInMinutes (the runner stack's literal must equal it). */
export const DEPLOY_BUILD_QUEUED_TIMEOUT_MINUTES = 30;
/** Build provisioning (image pull, env start) on top of the queue, inside the grant's life. */
export const DEPLOY_GRANT_PROVISIONING_MARGIN_MS = 15 * 60_000;

/** A grant's life: queue + provisioning, never shorter than the delivery lifetime. */
export function deployGrantTtlMs(queuedTimeoutMinutes: number = DEPLOY_BUILD_QUEUED_TIMEOUT_MINUTES): number {
  return Math.max(RUN_REQUEST_TTL_MS, queuedTimeoutMinutes * 60_000 + DEPLOY_GRANT_PROVISIONING_MARGIN_MS);
}
/** {@link deployGrantTtlMs} for the stack's queue timeout (45 min). */
export const DEPLOY_GRANT_TTL_MS = deployGrantTtlMs();

/**
 * The runner stack's DeployTimeoutMinutes parameter (CodeBuild TimeoutInMinutes).
 * `max` is the platform's deploy deadline (RUNNER_DEPLOY_DEADLINE_MINUTES'
 * default, 120): a longer build would only be cancelled by the platform first
 * (DEPLOY_TIMED_OUT).
 */
export const DEPLOY_BUILD_TIMEOUT_MINUTES = {
  default: 60,
  min: 10,
  max: Number(RUNNER_TUNABLE_DEFAULTS.RUNNER_DEPLOY_DEADLINE_MINUTES),
} as const;

/** The KMS encryption context `purpose` the grant is wrapped under in the runner's account. */
export const DEPLOY_GRANT_KMS_PURPOSE = 'deploy-grant';

/** Every key of {@link deployGrantEncryptionContext} (the grant key's policy allows these and no other). */
export const DEPLOY_GRANT_KMS_CONTEXT_KEYS = ['runnerId', 'purpose', 'requestId'] as const;

/**
 * The KMS encryption context of a wrapped grant: only the RunnerRole encrypts
 * and only the DeployRole decrypts under it. `requestId` (the deploy request's
 * id = PB_REQUEST_ID) binds each ciphertext to ONE request: KMS refuses to
 * decrypt it under any other request's context.
 */
export function deployGrantEncryptionContext(runnerId: string, requestId: string): {
  runnerId: string; purpose: typeof DEPLOY_GRANT_KMS_PURPOSE; requestId: string;
} {
  return { runnerId, purpose: DEPLOY_GRANT_KMS_PURPOSE, requestId };
}

/** The KMS ciphertext blob of a grant, base64 (PB_DEPLOY_GRANT_CIPHERTEXT). */
export const DEPLOY_GRANT_CIPHERTEXT_PATTERN = /^[A-Za-z0-9+/]{16,4096}={0,2}$/;

// ---- The job ----

/** The managed image the deploy job runs (the pipeline's toolchain cdk-synth, pinned by digest). */
export const DEPLOY_JOB_IMAGE_REPOSITORY = 'system/cdk-synth';
/** An image digest. */
export const DEPLOY_IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * The deploy-job protocol the platform speaks. `pipeline-manager pipeline
 * deploy-job --protocol` prints the image's; a toolchain release records the
 * one its cdk-synth ships; the platform refuses an older release
 * (TOOLCHAIN_TOO_OLD_FOR_DEPLOY) and the job refuses a claim that differs
 * (DEPLOY_JOB_PROTOCOL_MISMATCH). Bump on any incompatible change to the
 * claim, the env, the session facade or the result codes.
 */
export const DEPLOY_JOB_PROTOCOL_VERSION = 1;

/**
 * The cdk-synth half's plugin-spec `metadata` key recording the deploy-job
 * protocol its image ships (`pipeline-manager pipeline deploy-job --protocol`).
 * The upload of that half copies it onto the release
 * (`toolchain_release.deploy_job_protocol`); a release without it cannot
 * deploy a pipeline through a runner (TOOLCHAIN_TOO_OLD_FOR_DEPLOY).
 */
export const DEPLOY_JOB_PROTOCOL_METADATA_KEY = 'pb:deploy-job:protocol';

/** The protocol a cdk-synth row's `metadata` records (a whole number >= 1, as a number or digit string), else null. */
export function deployJobProtocolFromMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>)[DEPLOY_JOB_PROTOCOL_METADATA_KEY];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** What the job does: deploy the pipeline, or delete its stack (only when tagged for this pipeline). */
export const DEPLOY_JOB_MODES = ['deploy', 'undeploy'] as const;
export type DeployJobMode = (typeof DEPLOY_JOB_MODES)[number];

/** Every env name of the deploy job. The runner overrides only {@link DEPLOY_JOB_OVERRIDE_ENV}; the job exports {@link DEPLOY_JOB_EXPORTED_VARIABLES}. */
export const DEPLOY_JOB_ENV = {
  requestId: 'PB_REQUEST_ID',
  pipelineId: 'PB_PIPELINE_ID',
  region: 'PB_TARGET_REGION',
  pipelineName: 'PB_PIPELINE_NAME',
  stackName: 'PB_STACK_NAME',
  grantCiphertext: 'PB_DEPLOY_GRANT_CIPHERTEXT',
  toolchainRelease: 'PB_TOOLCHAIN_RELEASE',
  protocol: 'PB_DEPLOY_PROTOCOL',
  mode: 'PB_JOB_MODE',
  result: 'PB_DEPLOY_RESULT',
  stage: 'PB_DEPLOY_STAGE',
} as const;
export type DeployJobEnvName = (typeof DEPLOY_JOB_ENV)[keyof typeof DEPLOY_JOB_ENV];

/** The job's exported variables (read back through BatchGetBuilds by deploy_status). */
export const DEPLOY_JOB_EXPORTED_VARIABLES = [DEPLOY_JOB_ENV.result, DEPLOY_JOB_ENV.stage] as const;
/** The only env overrides the runner passes to StartBuild. */
export const DEPLOY_JOB_OVERRIDE_ENV = [
  DEPLOY_JOB_ENV.requestId, DEPLOY_JOB_ENV.pipelineId, DEPLOY_JOB_ENV.region, DEPLOY_JOB_ENV.pipelineName, DEPLOY_JOB_ENV.stackName,
  DEPLOY_JOB_ENV.grantCiphertext, DEPLOY_JOB_ENV.toolchainRelease, DEPLOY_JOB_ENV.protocol, DEPLOY_JOB_ENV.mode,
] as const;

/** The runner stack's deploy CodeBuild project. */
export function deployProjectName(runnerId: string): string {
  return `pipeline-builder-runner-deploy-${runnerId}`;
}

/** Its CloudWatch log group. */
export function deployLogGroupName(runnerId: string): string {
  return `/aws/codebuild/${deployProjectName(runnerId)}`;
}

/** Where to look in the runner's account for a deploy's build logs. Never an account id (a build id is `<project>:<uuid>`). */
export interface DeployLogHint {
  project: string;
  logGroup: string;
  buildId: string | null;
}

export function deployLogHint(runnerId: string, buildId: string | null): DeployLogHint {
  return { project: deployProjectName(runnerId), logGroup: deployLogGroupName(runnerId), buildId };
}

/** The command that turns deploys on for a runner. */
export const DEPLOY_SETUP_COMMAND = 'pipeline-manager infra setup-runner --enable-deploy';

// ---- The session facade (the job's only platform surface) ----

/** The facade routes under `/api/pipelines/runner/deploys/:requestId/`. `session` exchanges the grant; the rest take the session token. */
export const DEPLOY_SESSION_LEAVES = ['session', 'pipeline', 'plugin-lookup', 'progress', 'registry', 'result'] as const;
export type DeploySessionLeaf = (typeof DEPLOY_SESSION_LEAVES)[number];

export function runnerDeployPath(requestId: string, leaf: DeploySessionLeaf): string {
  return `/api/pipelines/runner/deploys/${encodeURIComponent(requestId)}/${leaf}`;
}

// ---- Runner replies to the deploy actions (details beside `outcome`) ----

/** `deploying` / `undeploying` (the build started, or the one already running for this request id). */
export interface RunnerDeployStartedReply {
  buildId: string;
}

/** `deploy_status`: state, stage and result code only — never logs, messages or ARNs. */
export interface RunnerDeployStatusReply {
  buildState: DeployBuildState;
  stage: DeployStage | null;
  resultCode: DeployJobResultCode | null;
}

/** `deploy_cancelled` (StopBuild accepted; the final status comes from the poll). */
export interface RunnerDeployCancelledReply {
  buildState: DeployBuildState;
}

// ---- Runner selection and purge ----

/**
 * Why a purge left a pipeline's stack in the customer's account instead of
 * asking its runner to remove it (purge result `stackRetained.reason`, the 409's
 * `details.stackRetainedReason`, and the deleted-pipeline row's notice).
 * `undeploy_not_queued`: an undeploy through a capable runner was planned, but
 * queueing it failed after the purge landed.
 */
export const STACK_RETAINED_REASONS = ['no_runner', 'runner_not_deploy_capable', 'toolchain_too_old', 'no_stack', 'undeploy_not_queued'] as const;
export type StackRetainedReason = (typeof STACK_RETAINED_REASONS)[number];

/** Why an eligible runner cannot deploy a pipeline (`GET …/deploy-targets`, `details.reason` of RUNNER_NOT_DEPLOYABLE). */
export const DEPLOY_TARGET_REASONS = ['deploy_not_enabled', 'update_required', 'unhealthy', 'prefix_mismatch', 'team_deploys_not_shared', 'region'] as const;
export type DeployTargetReason = (typeof DEPLOY_TARGET_REASONS)[number];

// ---- Metrics ----

/** Metric names the deploy path and its alerts share. */
export const RUNNER_DEPLOY_METRICS = {
  /** Counter `{outcome}`: finished deploys (deployed | failed | expired | cancelled). */
  deploys: 'pipeline_runner_deploys_total',
  /** Counter `{class}`: failed deploys by {@link DeployFailureClass} (RunnerDeployPlatformFailures on class="platform"). */
  failuresByClass: 'pipeline_runner_deploy_failures_total',
  /** Histogram: accepted → finished. */
  duration: 'pipeline_runner_deploy_duration_seconds',
  /** Gauge: deploying requests past their deadline (RunnerDeployStuck). */
  overdue: 'pipeline_runner_deploys_overdue',
  /** Counter `{reason}`: refused grant exchanges by {@link DeployGrantRejectionReason} (RunnerDeployGrantReuse on reason="reused"). */
  grantRejections: 'pipeline_runner_deploy_grant_rejections_total',
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
  /** What its bundle reported in its last pong (`deploy:1`: deploys enabled). */
  capabilities: RunnerCapability[];
  /** Teams this runner is shared with may also DEPLOY through it (off by default; needs shareWithTeams). */
  shareDeploysWithTeams: boolean;
  /** The pipeline-name prefixes its stack allows (`*` = all), as its last pong reported them. */
  pipelinePrefixes: string[];
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
  runner: {
    id: string;
    label: string;
    health: RunnerHealth;
    lastDeliveryAt: string | null;
    ownerOrgName: string | null;
    isOwn: boolean;
    /** What its bundle reported in its last pong (`deploy:1`: a purge removes the pipeline's stack through it). */
    capabilities: RunnerCapability[];
  } | null;
  checkedAt: string | null;
  detail: RunnerLinkDetail | null;
  /** The platform pause toggle is on (the pipeline page's banner). */
  deliveriesPaused: boolean;
}

/**
 * `deployment` on each row of `GET /pipelines/deleted` (the Recently deleted
 * list): what a PURGE of the tombstone does to its stack. Null when the
 * pipeline has no registration (nothing deployed, nothing to remove).
 */
export interface DeletedPipelineDeploymentDto {
  stackName: string | null;
  region: string | null;
  /** The registry row's linked runner (labels only), or null. */
  runner: { id: string; label: string; capabilities: RunnerCapability[] } | null;
  /**
   * A purge sends that runner an `undeploy` and the stack goes with the
   * pipeline (an active runner listing `deploy:1`, and a stack name and region
   * to remove). False: the stack stays in the account — remove it with
   * `cdk destroy` / CloudFormation (and a purge needs `?force=true`).
   */
  stackRemovedOnPurge: boolean;
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

// ---- Register deployment DTOs ----

/** One runner on `GET /pipelines/:pipelineId/register-runners`. Never an account id or a URL. */
export interface RegisterRunnerDto {
  id: string;
  label: string;
  /** The caller's org owns it (false for an ancestor's shared runner). */
  isOwn: boolean;
  /** Set for every runner that is not the caller's own. */
  ownerOrgName: string | null;
  /** Its allowed regions (the dialog fills the Region field from a single one). */
  regions: string[];
  /** `unreachable`: a link probe through it fails until it answers again. */
  health: RunnerHealth;
}

/**
 * `GET /pipelines/:pipelineId/register-runners` (`pipelines:read`) — what the
 * Register deployment dialog needs: every runner the org can register the
 * pipeline with (deploys enabled or not — registering only links), and the
 * pipeline's registration state.
 */
export interface RegisterRunnersDto {
  pipelineId: string;
  /** False when deliveries are paused or runner secrets are not set up: no runner can link it. */
  available: boolean;
  unavailableReason: RunnersUnavailableReason | null;
  /** Empty when not `available`. */
  runners: RegisterRunnerDto[];
  /** It has a registry row now. */
  registered: boolean;
  /** Any pipeline event was ever ingested for it — false and not registered: never deployed. */
  hasEvents: boolean;
  /** The runner it is linked to now (null when none). */
  linkedRunnerId: string | null;
}

// ---- Deploy DTOs ----

/** One eligible runner on `GET /pipelines/:pipelineId/deploy-targets`. Never an account id or a URL. */
export interface DeployTargetRunnerDto {
  id: string;
  label: string;
  /** The caller's org owns it (false for an ancestor's shared runner). */
  isOwn: boolean;
  /** Set for every runner that is not the caller's own. */
  ownerOrgName: string | null;
  /** Its allowed regions (a deploy into one of them; required in the body when there are several). */
  regions: string[];
  deployable: boolean;
  /** Null when deployable. */
  reason: DeployTargetReason | null;
}

/** `GET /pipelines/:pipelineId/deploy-targets`. */
export interface DeployTargetsDto {
  pipelineId: string;
  available: boolean;
  unavailableReason: RunnersUnavailableReason | null;
  /** The pipeline already has a registry row (no deploy through a runner). */
  alreadyDeployed: boolean;
  /** The pipeline's active deploy, if any (resume it instead of starting one). */
  activeRequestId: string | null;
  /** Every eligible runner, deployable or not. */
  runners: DeployTargetRunnerDto[];
  /** The runner used when the body names none: set when exactly one is deployable. */
  autoRunnerId: string | null;
  /** {@link DEPLOY_SETUP_COMMAND}, for the "no deployable runner" copy. */
  setupCommand: string;
}

/** `POST /pipelines/:pipelineId/deploys` body. */
export interface DeployStartBody {
  runnerId?: string;
  region?: string;
}

/** The 202 of `POST /pipelines/:pipelineId/deploys`. `reused`: the pipeline's active deploy on the same runner was returned instead of a new one. */
export interface QueuedDeployDto {
  requestId: string;
  status: ActiveDeployStatus;
  runnerLabel: string;
  region: string;
  reused: boolean;
}

/** `GET /pipelines/:pipelineId/deploys/latest` and `GET /pipelines/:pipelineId/deploys/:requestId`. */
export interface DeployRequestDto {
  requestId: string;
  pipelineId: string;
  status: DeployRequestStatus;
  stage: DeployStage;
  runnerId: string;
  runnerLabel: string;
  region: string;
  /** Set on a failed / expired / cancelled request. */
  errorCode: DeployErrorCode | null;
  failureClass: DeployFailureClass | null;
  /** Whether Retry / Change runner is offered ({@link deployFailureOf}); false while not failed. */
  retryable: boolean;
  requestedAt: string;
  /** When the runner answered `deploying`. */
  acceptedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  /** Where the build logs are in the runner's account ({@link deployLogHint}); null before the runner accepted. */
  logHint: DeployLogHint | null;
}

/** `POST …/deploys/:requestId/session` body. */
export interface DeploySessionBody {
  grant: string;
}

/** The 200 of `POST …/deploys/:requestId/session` (`Cache-Control: no-store`). */
export interface DeploySessionDto {
  /** {@link DEPLOY_SESSION_PATTERN}; sent back as `Authorization: Bearer`. */
  sessionToken: string;
  expiresAt: string;
  requestId: string;
  pipelineId: string;
  region: string;
  pipelineName: string;
  stackName: string;
  toolchainRelease: string;
  protocol: number;
}

/** `POST …/deploys/:requestId/progress` body. */
export interface DeployProgressBody {
  stage: DeployStage;
}

/** `POST …/deploys/:requestId/result` body. */
export interface DeployResultBody {
  code: DeployJobResultCode;
  /** The stage it ended in. */
  stage?: DeployStage;
}

/**
 * `POST …/deploys/:requestId/registry` body. The org, pipeline id and runner
 * come from the session; the names and region must be the deploy's own.
 */
export interface DeployRegistryBody {
  pipelineName: string;
  stackName: string;
  region: string;
  /** The synth's step manifest (pipeline-core `StepManifestEntry[]`), as `POST /pipelines/registry` takes it. */
  steps?: Array<Record<string, unknown>>;
}
