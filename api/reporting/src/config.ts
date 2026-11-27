// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reporting service's configuration, in one place.
 *
 * Every field is a GETTER that reads the environment on access. That keeps the
 * read timing each caller had before this object existed: a module-level
 * `const X = config.foo` still reads at import, a scheduler factory still reads
 * when the scheduler is built, and a per-render knob still reads per render —
 * which is what lets a suite set `process.env` between cases. Every read is a
 * LITERAL envInt / envBool / envStr call so the env-documented guard sees it.
 */

import { DEFAULT_LEADER_LOCK_TTL_MS, envBool, envInt, envStr } from '@pipeline-builder/api-core';

export interface ReportingConfig {
  http: {
    /** Timeout (ms) for reporting's outbound service calls. */
    readonly timeoutMs: number;
  };
  /** Base URL user-facing report links are built from (no trailing slash). */
  readonly publicBaseUrl: string;
  retention: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly startupDelayMs: number;
    readonly lockTtlMs: number;
    readonly batchSize: number;
    readonly maxBatchesPerTable: number;
  };
  rollup: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly startupDelayMs: number;
    readonly lockTtlMs: number;
  };
  scheduler: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly startupDelayMs: number;
    readonly lockTtlMs: number;
    readonly batch: number;
    readonly concurrency: number;
    readonly runTimeoutMs: number;
    readonly catchupMax: number;
    readonly settleHours: number;
    readonly jitterMs: number;
  };
  pdf: {
    readonly enabled: boolean;
    readonly chromiumPath: string;
    readonly timeoutMs: number;
    readonly concurrency: number;
    readonly queue: number;
    readonly queueWaitMs: number;
    readonly heapMb: number;
    readonly scratchDir: string;
  };
}

export const config: ReportingConfig = {
  http: {
    // Deliberately TIGHTER than the global HTTP_CLIENT_TIMEOUT_MS: see report-helpers.
    get timeoutMs() { return envInt('REPORTING_HTTP_TIMEOUT_MS', 3000, { min: 1 }); },
  },
  get publicBaseUrl() {
    return envStr('PLATFORM_FRONTEND_URL', envStr('PLATFORM_BASE_URL', 'https://localhost:8443')).replace(/\/+$/, '');
  },
  retention: {
    get enabled() { return envBool('REPORTING_RETENTION_ENABLED', true); },
    get intervalMs() { return envInt('REPORTING_RETENTION_INTERVAL_HOURS', 12, { min: 1 }) * 60 * 60 * 1000; },
    get startupDelayMs() { return envInt('REPORTING_RETENTION_STARTUP_DELAY_MS', 120_000, { min: 0 }); },
    // A CRASH-RECOVERY window, not a run-duration cover — withLeaderLock
    // heartbeats for as long as the sweep runs.
    get lockTtlMs() { return envInt('REPORTING_RETENTION_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1000 }); },
    get batchSize() { return envInt('REPORTING_RETENTION_BATCH_SIZE', 1000, { min: 1 }); },
    get maxBatchesPerTable() { return envInt('REPORTING_RETENTION_MAX_BATCHES', 50, { min: 1 }); },
  },
  rollup: {
    get enabled() { return envBool('REPORTING_ROLLUP_ENABLED', true); },
    get intervalMs() { return envInt('REPORTING_ROLLUP_INTERVAL_MINUTES', 60) * 60_000; },
    get startupDelayMs() { return envInt('REPORTING_ROLLUP_STARTUP_DELAY_MS', 60_000); },
    get lockTtlMs() { return envInt('REPORTING_ROLLUP_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS); },
  },
  scheduler: {
    get enabled() { return envBool('REPORT_SCHEDULER_ENABLED', true); },
    get intervalMs() { return envInt('REPORT_SCHEDULER_INTERVAL_MS', 300_000, { min: 1_000 }); },
    get startupDelayMs() { return envInt('REPORT_SCHEDULER_STARTUP_DELAY_MS', 60_000, { min: 0 }); },
    get lockTtlMs() { return envInt('REPORT_SCHEDULER_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1_000 }); },
    get batch() { return envInt('REPORT_SCHEDULER_BATCH', 25, { min: 1 }); },
    get concurrency() { return envInt('REPORT_SCHEDULER_CONCURRENCY', 3, { min: 1 }); },
    get runTimeoutMs() { return envInt('REPORT_RUN_TIMEOUT_MS', 120_000, { min: 1_000 }); },
    get catchupMax() { return envInt('REPORT_CATCHUP_MAX', 4, { min: 1 }); },
    get settleHours() { return envInt('REPORT_SETTLE_HOURS', 6, { min: 0 }); },
    get jitterMs() { return envInt('REPORT_JITTER_MS', 1_800_000, { min: 0 }); },
  },
  pdf: {
    get enabled() { return envBool('REPORT_PDF_ENABLED', true); },
    get chromiumPath() { return envStr('REPORT_PDF_CHROMIUM_PATH', '/usr/bin/chromium-browser'); },
    get timeoutMs() { return envInt('REPORT_PDF_TIMEOUT_MS', 20_000, { min: 1000 }); },
    get concurrency() { return envInt('REPORT_PDF_CONCURRENCY', 1, { min: 1 }); },
    get queue() { return envInt('REPORT_PDF_QUEUE', 4, { min: 0 }); },
    get queueWaitMs() { return envInt('REPORT_PDF_QUEUE_WAIT_MS', 5_000, { min: 0 }); },
    get heapMb() { return envInt('REPORT_PDF_HEAP_MB', 256, { min: 64 }); },
    get scratchDir() { return envStr('REPORT_PDF_SCRATCH_DIR', '/tmp/report-pdf'); },
  },
};
