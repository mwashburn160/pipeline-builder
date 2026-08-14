// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, createScheduler, createEnvRedisLock, type Scheduler } from '@pipeline-builder/api-core';
import { listRepositoriesUnderPrefix } from './registry-client.js';
import { runRegistryGc } from './registry-gc.js';
import { invalidateStorageCache } from './storage-usage.js';

const logger = createLogger('gc-scheduler');

const ORG_PREFIX = 'org-';

// Cross-pod leader-lock key + TTL. Without a lock every replica with
// REGISTRY_GC_ENABLED=true runs the DESTRUCTIVE sweep, so N pods redundantly
// walk the catalog and issue deletes at once. The lock makes exactly one pod
// sweep per window; absent Redis it degrades to no-op (runs on every pod — the
// per-manifest deletes are 404-tolerant, so that stays safe, just wasteful).
// The TTL must comfortably outlast one sweep (a sweep GCs every org namespace
// sequentially) yet stay well under the interval so the next cycle re-acquires.
const LOCK_KEY = 'image-registry:gc-scheduler:leader';

let scheduler: Scheduler | null = null;

interface SchedulerOptions {
  /** Whether the scheduler should be active. Defaults to false; opt in via env. */
  enabled: boolean;
  /** Interval between full sweeps. Defaults to 24h. */
  intervalMs: number;
  /** Manifests older than this many days are pruned. Defaults to 30. */
  maxAgeDays: number;
  /** Run on startup at `startupDelayMs`, then every `intervalMs`. */
  startupDelayMs: number;
  /** Leader-lock TTL (ms). Must outlast one sweep; under `intervalMs`. */
  lockTtlMs: number;
}

/**
 * Read scheduler config from env. Defaults err on the side of
 * conservative (off + 30d retention) so an operator has to opt in.
 *
 *   REGISTRY_GC_ENABLED         (default false)
 *   REGISTRY_GC_INTERVAL_HOURS  (default 24)
 *   REGISTRY_GC_MAX_AGE_DAYS    (default 30)
 *   REGISTRY_GC_STARTUP_DELAY_MS (default 300000 — 5 min, gives the registry
 *                                  time to settle before we hammer it)
 *   REGISTRY_GC_LOCK_TTL_MS     (default 900000 — 15 min; leader-lock TTL,
 *                                  generous so a long sweep doesn't lapse it)
 */
function readConfig(): SchedulerOptions {
  return {
    enabled: process.env.REGISTRY_GC_ENABLED === 'true',
    intervalMs: parseInt(process.env.REGISTRY_GC_INTERVAL_HOURS ?? '24', 10) * 60 * 60 * 1000,
    maxAgeDays: parseInt(process.env.REGISTRY_GC_MAX_AGE_DAYS ?? '30', 10),
    startupDelayMs: parseInt(process.env.REGISTRY_GC_STARTUP_DELAY_MS ?? '300000', 10),
    lockTtlMs: parseInt(process.env.REGISTRY_GC_LOCK_TTL_MS ?? '900000', 10),
  };
}

/**
 * One full sweep — discovers every `org-*` namespace from the registry
 * catalog and runs GC on each. Per-org failures are logged but don't
 * abort the rest of the sweep; the next run gets a clean attempt.
 */
async function sweepOnce(maxAgeDays: number): Promise<void> {
  const startMs = Date.now();
  let repos: string[];
  try {
    repos = await listRepositoriesUnderPrefix(ORG_PREFIX);
  } catch (err) {
    logger.warn('GC sweep: catalog listing failed; skipping cycle', { error: errorMessage(err) });
    return;
  }

  // Extract the namespace (e.g. `org-acme/`) so we run GC once per org rather
  // than per-repo — `org-acme/foo` and `org-acme/bar` share the same prefix.
  const orgPrefixes = new Set<string>();
  for (const r of repos) {
    const slash = r.indexOf('/');
    if (slash === -1) continue;
    orgPrefixes.add(r.slice(0, slash + 1));
  }

  if (orgPrefixes.size === 0) {
    logger.info('GC sweep: no org-* namespaces found, nothing to do');
    return;
  }

  let totalCandidates = 0;
  let totalDeleted = 0;
  for (const prefix of orgPrefixes) {
    try {
      const result = await runRegistryGc({ prefix, maxAgeDays });
      totalCandidates += result.candidates;
      totalDeleted += result.deleted;
      if (result.deleted > 0) {
        logger.info('GC sweep: pruned namespace', {
          prefix, candidates: result.candidates, deleted: result.deleted,
        });
      }
    } catch (err) {
      logger.warn('GC sweep: per-namespace run failed', { prefix, error: errorMessage(err) });
    }
  }

  // Force the storage cache to recompute on the next dashboard refresh —
  // the registry's blob-bytes are now stale relative to what we deleted.
  for (const prefix of orgPrefixes) invalidateStorageCache(prefix);

  logger.info('GC sweep complete', {
    namespaces: orgPrefixes.size,
    candidates: totalCandidates,
    deleted: totalDeleted,
    durationMs: Date.now() - startMs,
  });
}

/**
 * Start the in-process GC scheduler if `REGISTRY_GC_ENABLED=true`. Runs
 * an initial sweep after `startupDelayMs`, then every `intervalMs`.
 * Idempotent — calling twice is a no-op.
 *
 * Stops automatically on SIGTERM.
 */
export function startGcScheduler(): void {
  const cfg = readConfig();
  if (!cfg.enabled) {
    logger.info('Registry GC scheduler disabled (set REGISTRY_GC_ENABLED=true to opt in)');
    return;
  }
  if (scheduler) return;

  // Cross-pod single-runner lock so only ONE replica runs the destructive sweep
  // per window (like the marketplace-metering / compliance-scan crons). Null when
  // Redis is unconfigured — then the scheduler runs on every pod (still safe: the
  // per-manifest deletes tolerate 404s), matching the pre-lock behavior.
  const lockClient = createEnvRedisLock();

  logger.info('Registry GC scheduler starting', {
    intervalHours: cfg.intervalMs / 3_600_000,
    maxAgeDays: cfg.maxAgeDays,
    startupDelayMs: cfg.startupDelayMs,
    locked: !!lockClient,
  });

  // First sweep after a short delay so the registry has had time to start
  // accepting connections; subsequent sweeps run on the cadence.
  scheduler = createScheduler({
    name: 'gc-scheduler',
    intervalMs: cfg.intervalMs,
    startupDelayMs: cfg.startupDelayMs,
    run: () => sweepOnce(cfg.maxAgeDays),
    ...(lockClient ? { lock: { redis: () => lockClient, key: LOCK_KEY, ttlMs: cfg.lockTtlMs } } : {}),
  });
  scheduler.start();

  process.once('SIGTERM', stopGcScheduler);
}

/** Stop the scheduler. Exported mainly for tests / clean shutdown. */
export function stopGcScheduler(): void {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}
