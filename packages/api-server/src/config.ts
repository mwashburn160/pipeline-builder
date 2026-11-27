// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * api-server's configuration, in one typed object.
 *
 * Two read timings, kept as they were before this object existed:
 *  - plain fields are read ONCE, when this module is first evaluated (the
 *    quota-check cache TTLs and the readiness cadence were module constants);
 *  - getters are read on EVERY access, because their callers read them per
 *    construction / per connect / per write (`SSEManager`'s constructor,
 *    `connectMongo`, the write pin), and tests set `process.env` in between.
 *
 * Read env only through api-core's `envInt`/`envBool`/`envStr` so every knob is
 * picked up by the docs-drift test.
 */

import { envInt } from '@pipeline-builder/api-core';

export interface ApiServerConfig {
  /** Per-pod quota-check cache (`checkQuota`). */
  readonly quotaCheck: {
    /** TTL of a cached ALLOWED check, ms; `0` disables the cache (`QUOTA_CHECK_CACHE_TTL_MS`). */
    readonly cacheTtlMs: number;
    /** Longest a DENIED check is reused, ms (`QUOTA_CHECK_DENIED_CACHE_MS`). */
    readonly deniedCacheMs: number;
    /** Most cached (org, quota type) readings per pod (`QUOTA_CHECK_CACHE_MAX_ENTRIES`). */
    readonly cacheMaxEntries: number;
  };
  /** Dependency supervisor in `startServer`. */
  readonly readiness: {
    /** How often a connected service re-probes its datastore, ms (`READINESS_MONITOR_INTERVAL_MS`). */
    readonly monitorIntervalMs: number;
  };
  /** `SSEManager` defaults (an explicit constructor option wins). Read per construction. */
  readonly sse: {
    /** `SSE_MAX_CLIENTS_PER_REQUEST`. */
    readonly maxClientsPerRequest: number;
    /** `SSE_MAX_TOTAL_CLIENTS`. */
    readonly maxTotalClients: number;
    /** `SSE_MAX_CLIENTS_PER_ORG`. */
    readonly maxClientsPerOrg: number;
    /** Idle client timeout, ms (`SSE_CLIENT_TIMEOUT_MS`). */
    readonly clientTimeoutMs: number;
    /** Stale-client sweep interval, ms (`SSE_CLEANUP_INTERVAL_MS`). */
    readonly cleanupIntervalMs: number;
  };
  /** Mongoose connection pool (`connectMongo`). Read per connect. */
  readonly mongo: {
    /** `MONGO_MAX_POOL`. */
    readonly maxPoolSize: number;
    /** `MONGO_MIN_POOL`. */
    readonly minPoolSize: number;
    /** Server selection timeout, ms (`MONGO_SERVER_SELECTION_MS`). */
    readonly serverSelectionTimeoutMs: number;
  };
  /** Read-replica routing. Read per write. */
  readonly readReplica: {
    /** How long a write keeps its org on the primary, s (`DB_READ_WRITE_PIN_TTL_SECONDS`). */
    readonly writePinTtlSeconds: number;
  };
}

export const apiServerConfig: ApiServerConfig = {
  quotaCheck: {
    cacheTtlMs: envInt('QUOTA_CHECK_CACHE_TTL_MS', 5000, { min: 0 }),
    deniedCacheMs: envInt('QUOTA_CHECK_DENIED_CACHE_MS', 60000, { min: 0 }),
    cacheMaxEntries: envInt('QUOTA_CHECK_CACHE_MAX_ENTRIES', 10_000, { min: 1 }),
  },
  readiness: {
    monitorIntervalMs: envInt('READINESS_MONITOR_INTERVAL_MS', 15_000, { min: 1 }),
  },
  sse: {
    get maxClientsPerRequest() { return envInt('SSE_MAX_CLIENTS_PER_REQUEST', 10, { min: 1 }); },
    get maxTotalClients() { return envInt('SSE_MAX_TOTAL_CLIENTS', 1000, { min: 1 }); },
    get maxClientsPerOrg() { return envInt('SSE_MAX_CLIENTS_PER_ORG', 50, { min: 1 }); },
    get clientTimeoutMs() { return envInt('SSE_CLIENT_TIMEOUT_MS', 1_800_000, { min: 1 }); }, // 30 minutes
    get cleanupIntervalMs() { return envInt('SSE_CLEANUP_INTERVAL_MS', 300_000, { min: 1 }); }, // 5 minutes
  },
  mongo: {
    get maxPoolSize() { return envInt('MONGO_MAX_POOL', 20, { min: 1 }); },
    get minPoolSize() { return envInt('MONGO_MIN_POOL', 2, { min: 0 }); },
    get serverSelectionTimeoutMs() { return envInt('MONGO_SERVER_SELECTION_MS', 5000, { min: 1 }); },
  },
  readReplica: {
    get writePinTtlSeconds() { return envInt('DB_READ_WRITE_PIN_TTL_SECONDS', 10); },
  },
};
