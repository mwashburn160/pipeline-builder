// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-account runner vocabulary — the platform-side error codes the API
 * answers with, the runner-side codes a runner answers with, and the timing
 * constants of the delivery protocol (docs: the runner v6 contract).
 */

import { createLogger } from '@pipeline-builder/api-core';
import {
  PENDING_RUN_REQUEST_STATUSES, RUNNER_REPLY_ERROR_CODES, runnerTunable, TERMINAL_RUN_REQUEST_STATUSES,
  type RunnerDeliveryFailureClass, type RunnerErrorCode, type RunRequestStatus, type RunnerTunableEnv,
} from '@pipeline-builder/api-core/pipeline-runners';

const logger = createLogger('runner-settings');
/** One stable sink, so api-core warns once per bad value however often the settings are read. */
const warnTunable = (message: string): void => { logger.warn(message); };

/** One runner tunable from `env` (digits only; anything else is the default, logged once). */
export function tunable(name: RunnerTunableEnv, env: Readonly<Record<string, string | undefined>> = process.env): number {
  return runnerTunable(name, env, warnTunable);
}

// The contract half (codes, statuses, outcomes, the request lifetime) is
// api-core's `pipeline-runners` catalog, shared with the runner Lambda, the CLI
// and the dashboard; re-exported here under the names this service uses.
export { RUNNER_OUTCOMES, RUN_REQUEST_TTL_MS, UNREACHABLE_AFTER_FAILURES, type RunnerOutcome } from '@pipeline-builder/api-core/pipeline-runners';

export const TERMINAL_STATUSES: readonly RunRequestStatus[] = TERMINAL_RUN_REQUEST_STATUSES;
export const PENDING_STATUSES: readonly RunRequestStatus[] = PENDING_RUN_REQUEST_STATUSES;

/** Error codes a RUNNER answers with (its 4xx/5xx `errorCode`). */
export const RUNNER_REPLY_ERRORS = RUNNER_REPLY_ERROR_CODES;

// Terminal codes the platform records on a request on its own.
/** Not delivered within the request's 10 minutes. */
export const RUN_REQUEST_EXPIRED = 'RUN_REQUEST_EXPIRED' satisfies RunnerErrorCode;
/** A discovery probe that found nothing (probe rows only). */
export const NO_MATCH = 'NO_MATCH' satisfies RunnerErrorCode;
/** The routed runner is no longer one the request's org may use (re-checked before delivery). */
export const RUNNER_NOT_ELIGIBLE = 'RUNNER_NOT_ELIGIBLE' satisfies RunnerErrorCode;

/** Push delivery's per-attempt timeout. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Retry backoff cap (1, 2, 4, … 30 s). */
export const MAX_BACKOFF_MS = 30_000;
/** NOT_YET_VISIBLE: retry this often … */
export const NOT_YET_VISIBLE_RETRY_MS = 15_000;
/** … for at most this long after the request was made. */
export const NOT_YET_VISIBLE_WINDOW_MS = 60_000;
/** Runners one org may register. */
export const MAX_RUNNERS_PER_ORG = 20;
/** A `pending` runner (registered, never given a URL) is deleted after this long. */
export const PENDING_RUNNER_TTL_MS = 24 * 60 * 60_000;
/** An execution's status is refreshed from the runner at most this often. */
export const STATUS_REFRESH_MS = 15_000;
/** The run-request status read is served from a cache this fresh. */
export const STATUS_READ_CACHE_MS = 2_000;

/** Delivery failure classes recorded in `last_delivery_error` (the shared catalog's). */
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
  MIN_RUNNER_VERSION: '7.0.0',
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
  /** RUN_REQUESTS_PER_MINUTE (6) — user start/stop requests per (org, pipeline) per minute. */
  runRequestsPerMinute: number;
  /** MAX_PENDING_PER_ORG (500) — pending user-initiated start/stop requests per org (system-initiated runs queue past it). */
  maxPendingPerOrg: number;
  /** MAX_IN_FLIGHT_PER_RUNNER (8) — deliveries in flight to one runner at a time. */
  maxInFlightPerRunner: number;
  /** RUNNER_HEALTH_PING_INTERVAL_SECONDS (60), in ms — every active runner gets a signed ping this often. */
  healthPingIntervalMs: number;
  /** RUNNER_UNHEALTHY_AFTER_PINGS (2) — consecutive failed health pings that mark a runner unreachable. */
  unhealthyAfterPings: number;
  /** DEPLOY_REQUESTS_PER_HOUR (20) — deploys through a runner per org per hour. */
  deployRequestsPerHour: number;
  /** MAX_ACTIVE_DEPLOYS_PER_RUNNER (2) — queued|delivering|deploying deploys on one runner. */
  maxActiveDeploysPerRunner: number;
  /** RUNNER_DEPLOY_DEADLINE_MINUTES (120), in ms — an accepted deploy past this is cancelled (DEPLOY_TIMED_OUT). */
  deployDeadlineMs: number;
  /** RUNNER_DEPLOY_STATUS_POLL_SECONDS (30), in ms — each running deploy's build is polled this often. */
  deployStatusPollMs: number;
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
    runRequestsPerMinute: tunable('RUN_REQUESTS_PER_MINUTE', env),
    maxPendingPerOrg: tunable('MAX_PENDING_PER_ORG', env),
    maxInFlightPerRunner: tunable('MAX_IN_FLIGHT_PER_RUNNER', env),
    healthPingIntervalMs: tunable('RUNNER_HEALTH_PING_INTERVAL_SECONDS', env) * 1000,
    unhealthyAfterPings: tunable('RUNNER_UNHEALTHY_AFTER_PINGS', env),
    deployRequestsPerHour: tunable('DEPLOY_REQUESTS_PER_HOUR', env),
    maxActiveDeploysPerRunner: tunable('MAX_ACTIVE_DEPLOYS_PER_RUNNER', env),
    deployDeadlineMs: tunable('RUNNER_DEPLOY_DEADLINE_MINUTES', env) * 60_000,
    deployStatusPollMs: tunable('RUNNER_DEPLOY_STATUS_POLL_SECONDS', env) * 1000,
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
/** The background runner-link probe at pipeline registration. */
export const SYSTEM_RUNNER_LINK = 'system:runner-link';
/** The sweep's signed deploy_status / deploy_cancel reads of a running deploy. */
export const SYSTEM_DEPLOY_STATUS = 'system:deploy-status';
/** The undeploy a purge sends for a pipeline linked to a deploy-capable runner. */
export const SYSTEM_UNDEPLOY = 'system:undeploy';

/**
 * A system-initiated request (a plugin-upgrade redeploy): it waits in the queue
 * past the org's pending cap instead of being refused 429 TOO_MANY_PENDING.
 */
export function isSystemRequester(requestedBy: string): boolean {
  return requestedBy.startsWith('system:');
}

/** Retry delay after the Nth (1-based) failed delivery attempt: 1, 2, 4, …, capped at 30 s. */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (n - 1));
}
