// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline service's own configuration, in one place.
 *
 * Every field is a GETTER that reads the environment on access, so each caller
 * keeps the read timing it had: a module-level `const X = config.foo` still
 * reads at import, and a per-call read still reads per call (which is what lets
 * a suite set `process.env` between cases). Every read is a LITERAL envInt /
 * envStr call so the env-documented guard sees it.
 *
 * Not here: the runner settings (`runners/vocabulary.ts` `runnerSettings`),
 * which take an injectable env object so the runner suites can drive them
 * without touching `process.env`.
 */

import { envInt, envStr, parseRemediationEnabled } from '@pipeline-builder/api-core';

/** Default for `PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS`. */
const DEFAULT_EXEC_IDEMPOTENCY_WINDOW_SECONDS = 10;

export interface PipelineServiceConfig {
  scorecard: {
    /** Cap on pipelines scored per org-wide roll-up. */
    readonly maxPipelines: number;
    /** Max concurrent per-pipeline computes in a roll-up. */
    readonly concurrency: number;
  };
  generate: {
    /** Per-org AI generation / repository analysis requests per minute. */
    readonly rateLimitPerMin: number;
  };
  pluginService: {
    /** Timeout (ms) for this service's calls into the plugin service. */
    readonly timeoutMs: number;
  };
  execution: {
    /** Server-side double-submit window (seconds) for the CodePipeline trigger. */
    readonly idempotencyWindowSeconds: number;
  };
  remediation: {
    /** The deployment's plugin-remediation knob (only the literal `false` turns it off). */
    readonly enabled: boolean;
  };
}

export const config: PipelineServiceConfig = {
  scorecard: {
    get maxPipelines() { return envInt('ORG_SCORECARD_MAX_PIPELINES', 50, { min: 1 }); },
    get concurrency() { return envInt('ORG_SCORECARD_CONCURRENCY', 4, { min: 1 }); },
  },
  generate: {
    get rateLimitPerMin() { return envInt('PIPELINE_GENERATE_RATE_LIMIT_PER_MIN', 20, { min: 1 }); },
  },
  pluginService: {
    // 30s: these calls are sometimes slow because plugin upload responses
    // include build queue results.
    get timeoutMs() { return envInt('PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS', 30000, { min: 1 }); },
  },
  execution: {
    // Below 1 is the default rather than a clamp to 1: a window of 0 (or a
    // negative) is a typo, and the default is the safe double-submit guard.
    get idempotencyWindowSeconds() {
      const n = envInt('PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS', DEFAULT_EXEC_IDEMPOTENCY_WINDOW_SECONDS);
      return n >= 1 ? n : DEFAULT_EXEC_IDEMPOTENCY_WINDOW_SECONDS;
    },
  },
  remediation: {
    get enabled() { return parseRemediationEnabled(envStr('PLUGIN_REMEDIATION_ENABLED', 'true')); },
  },
};
