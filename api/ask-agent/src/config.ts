// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import { envInt, envStr } from '@pipeline-builder/api-core';

/**
 * The Ask service's env-tunable settings, in one place.
 *
 * Every value is read through api-core's `envInt` / `envStr` so the docs-drift
 * guard (`packages/api-core/test/env-documented.test.ts`) sees it. Plain values
 * resolve once at import time. The members declared as getters re-read the
 * environment on every access, deliberately: the schedule window and the
 * self-hosted model address were always read per call (and their tests change
 * them between cases), so they keep that timing.
 */
interface AppConfig {
  rateLimits: {
    /** Ask requests per org per minute (every `/ask-agent` route). */
    askPerMin: number;
    /** `GET /ask-agent/availability` checks per user per minute. */
    availabilityPerMin: number;
    /** Draft-outcome reports per user per minute. */
    draftOutcomePerMin: number;
  };
  http: {
    /** Per-call timeout (ms) for a tool's call to a peer service. */
    timeoutMs: number;
    /** Cap (bytes) on a peer's response body. */
    maxResponseBytes: number;
  };
  model: {
    /** Per-model-call output-token cap for every generation Ask pays for. */
    maxOutputTokens: number;
    /** Charged generations one agent turn may start. */
    maxTurnGenerations: number;
  };
  modelProbe: {
    /** Upper bound (ms) on one live probe of the self-hosted model. */
    timeoutMs: number;
    /** How long (ms) one probe answer is reused. */
    cacheMs: number;
    /** `OPENAI_COMPATIBLE_BASE_URL` ('' when unset). Read per call. */
    readonly baseUrl: string;
    /** `OPENAI_COMPATIBLE_API_KEY` ('' when unset). Read per call. */
    readonly apiKey: string;
  };
  /** Directory the how-to grounding corpus is loaded from. */
  docsDir: string;
  /** The self-hosted model's scale schedule. Every member is read per call. */
  schedule: {
    /** `ASK_SCHEDULE_ENABLED` is exactly `'true'`. */
    readonly enabled: boolean;
    /** Scale-up cron ('' when unset). */
    readonly up: string;
    /** Scale-down cron ('' when unset). */
    readonly down: string;
    /** IANA zone the crons are read in; must match the CronJobs' `spec.timeZone`. */
    readonly timeZone: string;
  };
}

export const config: AppConfig = {
  rateLimits: {
    askPerMin: envInt('ASK_RATE_LIMIT_PER_MIN', 30, { min: 1 }),
    availabilityPerMin: envInt('ASK_AVAILABILITY_RATE_LIMIT_PER_MIN', 30, { min: 1 }),
    draftOutcomePerMin: envInt('ASK_DRAFT_OUTCOME_RATE_LIMIT_PER_MIN', 20, { min: 1 }),
  },
  http: {
    timeoutMs: envInt('ASK_HTTP_TIMEOUT_MS', 30000, { min: 1 }),
    maxResponseBytes: envInt('ASK_HTTP_MAX_RESPONSE_BYTES', 4 * 1024 * 1024, { min: 1024 }),
  },
  model: {
    maxOutputTokens: envInt('ASK_MAX_OUTPUT_TOKENS', 2048, { min: 64 }),
    maxTurnGenerations: envInt('ASK_MAX_TURN_GENERATIONS', 2, { min: 1, max: 10 }),
  },
  modelProbe: {
    timeoutMs: envInt('ASK_MODEL_PROBE_TIMEOUT_MS', 2500, { min: 200 }),
    cacheMs: envInt('ASK_MODEL_PROBE_CACHE_MS', 15_000, { min: 0 }),
    get baseUrl() {
      return envStr('OPENAI_COMPATIBLE_BASE_URL', '');
    },
    get apiKey() {
      return envStr('OPENAI_COMPATIBLE_API_KEY', '');
    },
  },
  docsDir: envStr('ASK_DOCS_DIR', join(process.cwd(), 'docs')),
  schedule: {
    get enabled() {
      // Exact match, as before: the deploy scripts write the literal `true`.
      return envStr('ASK_SCHEDULE_ENABLED', '') === 'true';
    },
    get up() {
      return envStr('ASK_SCHEDULE_UP', '');
    },
    get down() {
      return envStr('ASK_SCHEDULE_DOWN', '');
    },
    get timeZone() {
      return envStr('ASK_SCHEDULE_TIMEZONE', 'America/New_York');
    },
  },
};
