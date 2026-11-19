// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-account runner vocabulary — the platform-side error codes the API
 * answers with, the runner-side codes a runner answers with, and the timing
 * constants of the delivery protocol (docs: the runner v6 contract).
 */

import {
  PENDING_RUN_REQUEST_STATUSES, RUNNER_API_ERROR_CODES, RUNNER_DELIVERY_FAILURE_CLASSES, RUNNER_FEATURE, RUNNER_REPLY_ERROR_CODES, TERMINAL_RUN_REQUEST_STATUSES,
  type RunnerApiErrorCode, type RunnerDeliveryFailureClass, type RunnerErrorCode, type RunnerReplyErrorCode, type RunRequestStatus,
} from '@pipeline-builder/api-core/pipeline-runners';

// The contract half (codes, statuses, outcomes, the request lifetime) is
// api-core's `pipeline-runners` catalog, shared with the runner Lambda, the CLI
// and the dashboard; re-exported here under the names this service uses.
export { RUNNER_FEATURE, RUNNER_OUTCOMES, RUN_REQUEST_TTL_MS, type RunnerOutcome } from '@pipeline-builder/api-core/pipeline-runners';

export const TERMINAL_STATUSES: readonly RunRequestStatus[] = TERMINAL_RUN_REQUEST_STATUSES;
export const PENDING_STATUSES: readonly RunRequestStatus[] = PENDING_RUN_REQUEST_STATUSES;

/** Error codes the pipeline service answers with on a runner path (`code` of the error envelope). */
export const RUNNER_API_ERRORS = RUNNER_API_ERROR_CODES;
export type RunnerApiError = RunnerApiErrorCode;

/** Whether a request's principal holds the runner feature (superadmins hold every feature, as `requireFeature` rules). */
export function principalHasRunnerFeature(user: { isSuperAdmin?: boolean; features?: readonly string[] } | undefined): boolean {
  return !!user && (user.isSuperAdmin === true || !!user.features?.includes(RUNNER_FEATURE));
}

/** Error codes a RUNNER answers with (its 4xx/5xx `errorCode`). */
export const RUNNER_REPLY_ERRORS = RUNNER_REPLY_ERROR_CODES;
export type RunnerReplyError = RunnerReplyErrorCode;

// Terminal codes the platform records on a request on its own.
/** Not delivered within the request's 10 minutes. */
export const RUN_REQUEST_EXPIRED = 'RUN_REQUEST_EXPIRED' satisfies RunnerErrorCode;
/** A discovery probe that found nothing (probe rows only). */
export const NO_MATCH = 'NO_MATCH' satisfies RunnerErrorCode;

/** Push delivery's per-attempt timeout. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Retry backoff cap (1, 2, 4, … 30 s). */
export const MAX_BACKOFF_MS = 30_000;
/** NOT_YET_VISIBLE: retry this often … */
export const NOT_YET_VISIBLE_RETRY_MS = 15_000;
/** … for at most this long after the request was made. */
export const NOT_YET_VISIBLE_WINDOW_MS = 60_000;
/** Consecutive transport failures that mark a runner unreachable. */
export const UNREACHABLE_AFTER_FAILURES = 5;
/** An unreachable runner is pinged this often. */
export const UNREACHABLE_PING_INTERVAL_MS = 5 * 60_000;
/** Start/stop requests per (org, pipeline) per minute through a runner. */
export const RUN_REQUESTS_PER_MINUTE = 6;
/** Runners one org may register. */
export const MAX_RUNNERS_PER_ORG = 20;
/** Pending (queued|delivering) run requests one org may have. */
export const MAX_PENDING_PER_ORG = 50;
/** Deliveries in flight to one runner at a time. */
export const MAX_IN_FLIGHT_PER_RUNNER = 4;
/** A `pending` runner (registered, never given a URL) is deleted after this long. */
export const PENDING_RUNNER_TTL_MS = 24 * 60 * 60_000;
/** An execution's status is refreshed from the runner at most this often. */
export const STATUS_REFRESH_MS = 15_000;
/** The run-request status read is served from a cache this fresh. */
export const STATUS_READ_CACHE_MS = 2_000;

/** Delivery failure classes recorded in `last_delivery_error` (the shared catalog's). */
export const FAILURE_CLASSES = RUNNER_DELIVERY_FAILURE_CLASSES;
export type FailureClass = RunnerDeliveryFailureClass;

const envNumber = (raw: string | undefined, fallback: number, min: number): number => {
  const n = Number((raw ?? '').trim());
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};

/**
 * Each deployment knob's default, as the env string a deploy target declares.
 * The ONE copy: the deploy-contracts suite reads this literal to check every
 * target's `.env.example` and the compose file declare the same values.
 */
export const RUNNER_SETTING_DEFAULTS = {
  RUNNER_DISPATCH_CONCURRENCY: '16',
  MIN_RUNNER_VERSION: '',
  RUNNER_UPGRADE_GRACE_DAYS: '30',
  RUNNER_PLATFORM_EGRESS_IPS: '',
  RUNNER_REQUEST_RETENTION_DAYS: '90',
  RUNNER_FAILED_REQUEST_RETENTION_DAYS: '30',
} as const;
const DEFAULTS = RUNNER_SETTING_DEFAULTS;

/** Deployment knobs (all optional, safe defaults). */
export interface RunnerSettings {
  /** MIN_RUNNER_VERSION — runners below it are flagged `updateRequired`; null = no minimum. */
  minRunnerVersion: string | null;
  /** RUNNER_UPGRADE_GRACE_DAYS (30) — after this, a below-minimum runner is refused. */
  upgradeGraceDays: number;
  /** RUNNER_DISPATCH_CONCURRENCY (16) — the dispatcher's global worker concurrency. */
  dispatchConcurrency: number;
  /** RUNNER_PLATFORM_EGRESS_IPS (csv) — shown to admins for an API Gateway IP allowlist. */
  platformEgressIps: string[] | null;
  /** RUNNER_REQUEST_RETENTION_DAYS (90) — started/stopped requests are deleted after this. */
  retentionDays: number;
  /** RUNNER_FAILED_REQUEST_RETENTION_DAYS (30) — failed/expired requests are deleted after this. */
  failedRetentionDays: number;
}

export function runnerSettings(env: NodeJS.ProcessEnv = process.env): RunnerSettings {
  const min = (env.MIN_RUNNER_VERSION ?? DEFAULTS.MIN_RUNNER_VERSION).trim();
  const ips = (env.RUNNER_PLATFORM_EGRESS_IPS ?? DEFAULTS.RUNNER_PLATFORM_EGRESS_IPS).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    minRunnerVersion: /^\d+\.\d+\.\d+/.test(min) ? min : null,
    upgradeGraceDays: envNumber(env.RUNNER_UPGRADE_GRACE_DAYS, Number(DEFAULTS.RUNNER_UPGRADE_GRACE_DAYS), 0),
    dispatchConcurrency: envNumber(env.RUNNER_DISPATCH_CONCURRENCY, Number(DEFAULTS.RUNNER_DISPATCH_CONCURRENCY), 1),
    platformEgressIps: ips.length > 0 ? ips : null,
    retentionDays: envNumber(env.RUNNER_REQUEST_RETENTION_DAYS, Number(DEFAULTS.RUNNER_REQUEST_RETENTION_DAYS), 1),
    failedRetentionDays: envNumber(env.RUNNER_FAILED_REQUEST_RETENTION_DAYS, Number(DEFAULTS.RUNNER_FAILED_REQUEST_RETENTION_DAYS), 1),
  };
}

/**
 * Whether `version` is below `min` (semver major.minor.patch; pre-release and
 * build suffixes ignored). An unparseable version is never "below" — a runner
 * that reports none is not refused for it.
 */
export function versionBelow(version: string | null | undefined, min: string | null): boolean {
  if (!min || !version) return false;
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** The `requestedBy` of system-initiated requests. */
export const SYSTEM_PLUGIN_UPGRADE = 'system:plugin-upgrade';
export const SYSTEM_RUNNER_PING = 'system:runner-ping';

/** Retry delay after the Nth (1-based) failed delivery attempt: 1, 2, 4, …, capped at 30 s. */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (n - 1));
}
