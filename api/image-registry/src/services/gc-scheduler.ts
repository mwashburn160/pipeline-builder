// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incCounter } from '@pipeline-builder/api-server';
import { envInt, createLogger, errorMessage, createScheduler, createEnvRedisLock, type Scheduler, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS } from '@pipeline-builder/api-core';
import { listRepositoriesUnderPrefix } from './registry-client.js';
import { GC_FAILED_COUNTER, runQuarantineGc, runRegistryGc } from './registry-gc.js';
import { computeStorageUsage, invalidateStorageCache } from './storage-usage.js';

const logger = createLogger('gc-scheduler');

const ORG_PREFIX = 'org-';

// Cross-pod leader-lock key + TTL. Without a lock every replica with
// REGISTRY_GC_ENABLED=true runs the DESTRUCTIVE sweep, so N pods redundantly
// walk the catalog and issue deletes at once. The lock makes exactly one pod
// sweep per window; absent Redis it degrades to no-op (runs on every pod — the
// per-manifest deletes are 404-tolerant, so that stays safe, just wasteful).
// The TTL is the crash-recovery window only: the scheduler heartbeats the lock
// while a (long) sweep runs, so it need not outlast one; it must stay well under
// the interval so the next cycle re-acquires.
const LOCK_KEY = leaderLockKey('image-registry', 'gc-scheduler');

let scheduler: Scheduler | null = null;
let quarantineScheduler: Scheduler | null = null;

/** Leader-lock key of the quarantine sweep (independent of the org sweep's). */
const QUARANTINE_LOCK_KEY = leaderLockKey('image-registry', 'quarantine-gc');
/** The quarantine sweep's cadence — a quarter of a day keeps the 30-day bound tight. */
const QUARANTINE_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface SchedulerOptions {
  /** Whether the scheduler should be active. Defaults to false; opt in via env. */
  enabled: boolean;
  /** Interval between full sweeps. Defaults to 24h. */
  intervalMs: number;
  /** Manifests older than this many days are pruned. Defaults to 30. */
  maxAgeDays: number;
  /** Run on startup at `startupDelayMs`, then every `intervalMs`. */
  startupDelayMs: number;
  /** Leader-lock TTL (ms): the crash-recovery window (the lock is heartbeated); under `intervalMs`. */
  lockTtlMs: number;
}

/**
 * Read scheduler config from env. Defaults err on the side of
 * conservative (off + 30d retention) so an operator has to opt in.
 *
 *   REGISTRY_GC_ENABLED (default false)
 *   REGISTRY_GC_INTERVAL_HOURS (default 24)
 *   REGISTRY_GC_MAX_AGE_DAYS (default 30)
 *   REGISTRY_GC_STARTUP_DELAY_MS (default 300000 — 5 min, gives the registry
 *                                  time to settle before we hammer it)
 *   REGISTRY_GC_LOCK_TTL_MS (default api-core DEFAULT_LEADER_LOCK_TTL_MS;
 *                                  the crash-recovery window — the lock is
 *                                  heartbeated while a sweep runs)
 */
function readConfig(): SchedulerOptions {
  return {
    enabled: process.env.REGISTRY_GC_ENABLED === 'true',
    intervalMs: envInt('REGISTRY_GC_INTERVAL_HOURS', 24, { min: 1 }) * 60 * 60 * 1000,
    maxAgeDays: envInt('REGISTRY_GC_MAX_AGE_DAYS', 30, { min: 1 }),
    startupDelayMs: envInt('REGISTRY_GC_STARTUP_DELAY_MS', 300_000, { min: 0 }),
    lockTtlMs: envInt('REGISTRY_GC_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1 }),
  };
}

/**
 * One full sweep — discovers every `org-*` namespace from the registry
 * catalog and runs GC on each. A per-org failure doesn't abort the rest of the
 * sweep, but it is COUNTED (`registry_gc_failed_total{stage}`, alerted as
 * RegistryGcFailing). The sweep THROWS when the catalog can't be listed or
 * every namespace failed, so the scheduler records no success and
 * SchedulerJobStale fires — a registry that is down must not look swept.
 */
async function sweepOnce(maxAgeDays: number): Promise<void> {
  const startMs = Date.now();
  let repos: string[];
  try {
    repos = await listRepositoriesUnderPrefix(ORG_PREFIX);
  } catch (err) {
    incCounter(GC_FAILED_COUNTER, { stage: 'catalog' });
    throw new Error(`GC sweep: catalog listing failed: ${errorMessage(err)}`);
  }

  // Extract the namespace (e.g. `org-acme/`) so we run GC once per org rather
  // than per-repo — `org-acme/foo` and `org-acme/bar` share the same prefix.
  const orgPrefixes = new Set<string>();
  for (const r of repos) {
    const slash = r.indexOf('/');
    if (slash === -1) continue;
    orgPrefixes.add(r.slice(0, slash + 1));
  }

  // Refresh the `public/*` footprint gauge. The public
  // namespace itself is NOT swept — see isAgeGcExempt in registry-gc.ts.
  try {
    await computeStorageUsage('public/', { force: true });
  } catch (err) {
    logger.warn('GC sweep: public storage rollup failed', { error: errorMessage(err) });
  }

  if (orgPrefixes.size === 0) {
    logger.info('GC sweep: no org-* namespaces found, nothing to do');
    return;
  }

  let totalCandidates = 0;
  let totalDeleted = 0;
  let failedNamespaces = 0;
  for (const prefix of orgPrefixes) {
    try {
      const result = await runRegistryGc({ prefix, maxAgeDays });
      totalCandidates += result.candidates;
      totalDeleted += result.deleted;
      // A namespace none of whose repositories could be walked failed as a whole.
      if (result.reposScanned > 0 && result.failedRepos === result.reposScanned) failedNamespaces++;
      if (result.deleted > 0 || result.companionsDeleted > 0) {
        logger.info('GC sweep: pruned namespace', {
          prefix, candidates: result.candidates, deleted: result.deleted, companionsDeleted: result.companionsDeleted,
        });
      }
    } catch (err) {
      failedNamespaces++;
      incCounter(GC_FAILED_COUNTER, { stage: 'namespace' });
      logger.warn('GC sweep: per-namespace run failed', { prefix, error: errorMessage(err) });
    }
  }

  // Force the storage cache to recompute on the next dashboard refresh —
  // the registry's blob-bytes are now stale relative to what we deleted.
  for (const prefix of orgPrefixes) invalidateStorageCache(prefix);

  logger.info('GC sweep complete', {
    namespaces: orgPrefixes.size,
    failedNamespaces,
    candidates: totalCandidates,
    deleted: totalDeleted,
    durationMs: Date.now() - startMs,
  });
  if (failedNamespaces === orgPrefixes.size) {
    throw new Error(`GC sweep: every namespace failed (${failedNamespaces})`);
  }
}

/** Exported for tests: one org sweep, as the scheduler runs it. */
export const sweepOnceForTests = sweepOnce;

/**
 * Start the in-process GC scheduler if `REGISTRY_GC_ENABLED=true`. Runs
 * an initial sweep after `startupDelayMs`, then every `intervalMs`.
 * Idempotent — calling twice is a no-op.
 *
 * Stopped by runServer's coordinated onShutdown (index.ts).
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
  // Stopped by runServer's coordinated onShutdown (index.ts), not a racing
  // process.once('SIGTERM') of its own.
}

/** Stop the scheduler. Exported mainly for tests / clean shutdown. */
export function stopGcScheduler(): void {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}

/**
 * Start the ALWAYS-ON quarantine sweep (anonymous plugin submissions, plugin
 * ecosystem): every 6h, delete `quarantine/*` repos older than 30
 * days (runQuarantineGc). Unlike the org sweep this is not opt-in — quarantined
 * builds are disposable by definition and the 30-day bound is a retention
 * promise, not an operator preference. The plugin service deletes a
 * submission's repo as soon as it is decided (DELETE /internal/quarantine/:id);
 * this is the backstop. Idempotent; stopped by runServer's onShutdown.
 */
export function startQuarantineGcScheduler(): void {
  if (quarantineScheduler) return;
  const cfg = readConfig();
  const lockClient = createEnvRedisLock();
  quarantineScheduler = createScheduler({
    name: 'quarantine-gc',
    intervalMs: QUARANTINE_INTERVAL_MS,
    startupDelayMs: cfg.startupDelayMs,
    // Not caught here: a throw is what keeps the scheduler from stamping a
    // success, so SchedulerJobStale can see a sweep that keeps failing.
    run: async () => {
      await runQuarantineGc();
    },
    ...(lockClient ? { lock: { redis: () => lockClient, key: QUARANTINE_LOCK_KEY, ttlMs: cfg.lockTtlMs } } : {}),
  });
  quarantineScheduler.start();
}

/** Stop the quarantine sweep. Exported for tests / clean shutdown. */
export function stopQuarantineGcScheduler(): void {
  if (quarantineScheduler) {
    quarantineScheduler.stop();
    quarantineScheduler = null;
  }
}
