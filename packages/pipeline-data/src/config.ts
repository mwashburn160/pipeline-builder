// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pipeline-data's configuration, in one typed object.
 *
 * Two read timings, kept as they were before this object existed:
 *  - plain fields are read ONCE, when this module is first evaluated (the
 *    soft-delete retention and the report-cache TTLs were module constants);
 *  - getters are read on EVERY access, because their callers deliberately read
 *    per call (each scheduler build, each rollup pass, each lag sample) and
 *    tests set `process.env` in between.
 *
 * Database connection settings stay in `database/postgres-connection.ts` and
 * `database/read-connection.ts`, whose loaders build the pool options per pool.
 */

import { DEFAULT_LEADER_LOCK_TTL_MS, envBool, envInt } from '@pipeline-builder/api-core';

export interface PipelineDataConfig {
  /** Soft delete (CrudService tombstones and their purge sweep). */
  readonly softDelete: {
    /** Days before a tombstone is purge-eligible; `0` disables stamping (`SOFT_DELETE_RETENTION_DAYS`). */
    readonly retentionDays: number;
    /** Kill switch for every hard purge (`SOFT_DELETE_PURGE_ENABLED`). Read per call. */
    readonly purgeEnabled: boolean;
    /** Hours between purge sweeps (`SOFT_DELETE_PURGE_INTERVAL_HOURS`). Read per call. */
    readonly purgeIntervalHours: number;
    /** Delay before the first sweep after boot, ms (`SOFT_DELETE_PURGE_STARTUP_DELAY_MS`). Read per call. */
    readonly purgeStartupDelayMs: number;
    /** Cross-pod leader-lock TTL of a sweep, ms (`SOFT_DELETE_PURGE_LOCK_TTL_MS`). Read per call. */
    readonly purgeLockTtlMs: number;
  };
  /** Reporting caches and the daily rollup. */
  readonly reporting: {
    /** Inventory report cache TTL, s (`CACHE_TTL_REPORT_INVENTORY_SECONDS`). */
    readonly inventoryCacheTtlSeconds: number;
    /** Timeseries report cache TTL, s (`CACHE_TTL_REPORT_TIMESERIES_SECONDS`). */
    readonly timeseriesCacheTtlSeconds: number;
    /** Hours after a day closes before it is rolled up (`REPORTING_ROLLUP_SETTLE_HOURS`). Read per call. */
    readonly rollupSettleHours: number;
    /** Days rebuilt per rollup pass (`REPORTING_ROLLUP_BATCH_DAYS`). Read per call. */
    readonly rollupBatchDays: number;
  };
  /** Read-replica lag circuit. Read per sample. */
  readonly readLag: {
    /** Most lag a standby may have and still serve reads, s (`DB_READ_MAX_LAG_SECONDS`). */
    readonly maxLagSeconds: number;
    /** Interval between lag samples, ms (`DB_READ_LAG_SAMPLE_MS`). */
    readonly sampleIntervalMs: number;
    /** Bound on one lag sample, ms (`DB_READ_LAG_SAMPLE_TIMEOUT_MS`). */
    readonly sampleTimeoutMs: number;
  };
}

export const pipelineDataConfig: PipelineDataConfig = {
  softDelete: {
    retentionDays: envInt('SOFT_DELETE_RETENTION_DAYS', 30, { min: 0 }),
    get purgeEnabled() { return envBool('SOFT_DELETE_PURGE_ENABLED', true); },
    get purgeIntervalHours() { return envInt('SOFT_DELETE_PURGE_INTERVAL_HOURS', 6, { min: 1 }); },
    get purgeStartupDelayMs() { return envInt('SOFT_DELETE_PURGE_STARTUP_DELAY_MS', 120_000, { min: 0 }); },
    get purgeLockTtlMs() { return envInt('SOFT_DELETE_PURGE_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1000 }); },
  },
  reporting: {
    inventoryCacheTtlSeconds: envInt('CACHE_TTL_REPORT_INVENTORY_SECONDS', 300, { min: 1 }),
    timeseriesCacheTtlSeconds: envInt('CACHE_TTL_REPORT_TIMESERIES_SECONDS', 120, { min: 1 }),
    get rollupSettleHours() { return envInt('REPORTING_ROLLUP_SETTLE_HOURS', 6, { min: 0 }); },
    get rollupBatchDays() { return envInt('REPORTING_ROLLUP_BATCH_DAYS', 7, { min: 1 }); },
  },
  readLag: {
    get maxLagSeconds() { return envInt('DB_READ_MAX_LAG_SECONDS', 5); },
    get sampleIntervalMs() { return envInt('DB_READ_LAG_SAMPLE_MS', 5000); },
    get sampleTimeoutMs() { return envInt('DB_READ_LAG_SAMPLE_TIMEOUT_MS', 5000); },
  },
};
