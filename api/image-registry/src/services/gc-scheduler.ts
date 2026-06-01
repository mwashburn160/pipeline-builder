// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { listRepositories } from './registry-client';
import { runRegistryGc } from './registry-gc';
import { invalidateStorageCache } from './storage-usage';

const logger = createLogger('gc-scheduler');

const ORG_PREFIX = 'org-';

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

interface SchedulerOptions {
  /** Whether the scheduler should be active. Defaults to false; opt in via env. */
  enabled: boolean;
  /** Interval between full sweeps. Defaults to 24h. */
  intervalMs: number;
  /** Manifests older than this many days are pruned. Defaults to 30. */
  maxAgeDays: number;
  /** Run on startup at `startupDelayMs`, then every `intervalMs`. */
  startupDelayMs: number;
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
 */
function readConfig(): SchedulerOptions {
  return {
    enabled: process.env.REGISTRY_GC_ENABLED === 'true',
    intervalMs: parseInt(process.env.REGISTRY_GC_INTERVAL_HOURS ?? '24', 10) * 60 * 60 * 1000,
    maxAgeDays: parseInt(process.env.REGISTRY_GC_MAX_AGE_DAYS ?? '30', 10),
    startupDelayMs: parseInt(process.env.REGISTRY_GC_STARTUP_DELAY_MS ?? '300000', 10),
  };
}

/**
 * One full sweep — discovers every `org-*` namespace from the registry
 * catalog and runs GC on each. Per-org failures are logged but don't
 * abort the rest of the sweep; the next run gets a clean attempt.
 */
async function sweepOnce(maxAgeDays: number): Promise<void> {
  const startMs = Date.now();
  const orgPrefixes = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = await listRepositories({ n: 100, last: cursor });
      for (const r of page.repositories) {
        if (!r.startsWith(ORG_PREFIX)) continue;
        const slash = r.indexOf('/');
        if (slash === -1) continue;
        // Extract the namespace (e.g. `org-acme/`) so we run GC once per
        // org rather than per-repo. `org-acme/foo` and `org-acme/bar`
        // share the same prefix.
        orgPrefixes.add(r.slice(0, slash + 1));
      }
      cursor = page.next;
    } while (cursor);
  } catch (err) {
    logger.warn('GC sweep: catalog listing failed; skipping cycle', { error: errorMessage(err) });
    return;
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
  if (timer || startupTimer) return;

  logger.info('Registry GC scheduler starting', {
    intervalHours: cfg.intervalMs / 3_600_000,
    maxAgeDays: cfg.maxAgeDays,
    startupDelayMs: cfg.startupDelayMs,
  });

  stopped = false;
  // First sweep after a short delay so the registry has had time to start
  // accepting connections. Subsequent sweeps run on the cadence.
  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (stopped) return;
    void sweepOnce(cfg.maxAgeDays);
    timer = setInterval(() => void sweepOnce(cfg.maxAgeDays), cfg.intervalMs);
    timer.unref();
  }, cfg.startupDelayMs);
  startupTimer.unref();

  process.once('SIGTERM', stopGcScheduler);
}

/** Stop the scheduler. Exported mainly for tests / clean shutdown. */
export function stopGcScheduler(): void {
  stopped = true;
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Registry GC scheduler stopped');
  }
}
