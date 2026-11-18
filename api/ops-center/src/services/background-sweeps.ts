// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every periodic background sweep ops-center runs, in one registry.
 *
 * A sweep is a DEFINITION — `{ name, lockKey?, intervalMs, run }` — exported by
 * the module that owns the work; this file decides which ones apply to the
 * deployment, builds them and starts them. With a `lockKey` the sweep runs under
 * the cross-pod leader lock (one replica per window, see utils/leader-lock.ts);
 * without one it runs on every replica. Each is an api-core scheduler: unref'd,
 * start-once, and never overlapping itself on one pod.
 *
 * Started at boot and stopped, all together, on shutdown.
 */

import { createLogger, createScheduler, errorMessage, leaderLockKey, type LeaderLockRun, type Scheduler } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { createLockedSweep } from '../utils/leader-lock.js';

const logger = createLogger('background-sweeps');

/** A sweep built from its body. */
export interface IntervalSweepDefinition {
  name: string;
  /** Cross-pod leader-lock key; omit to run on every replica. */
  lockKey?: string;
  intervalMs: number;
  /** Run once at start (default true). */
  runOnStart?: boolean;
  /**
   * The sweep body. `run.signal` aborts when the lock is lost mid-run or the
   * process is shutting down; a sweep that iterates over units of work should
   * check it between them and return (see org-purge).
   */
  run: (run: LeaderLockRun) => Promise<void>;
  /**
   * TRUE only if running this body on several replicas at once is safe — every
   * unit of work atomically claimed, or the whole thing read-only. It licenses the
   * no-Redis path: without it a locked sweep SKIPS when Redis is unconfigured
   * rather than running everywhere (see utils/leader-lock.ts). Default false,
   * because the expensive mistake is assuming safety that isn't there.
   */
  concurrencySafe?: boolean;
}

/** A sweep whose owner builds its own scheduler (null = disabled in this deployment). */
export interface CustomSweepDefinition {
  name: string;
  create: () => Scheduler | null;
}

export type SweepDefinition = IntervalSweepDefinition | CustomSweepDefinition;

/** Build (not start) the scheduler for one definition; null when it is disabled. */
export function buildSweep(def: SweepDefinition): Scheduler | null {
  if ('create' in def) return def.create();
  const { name, lockKey, intervalMs, runOnStart, run, concurrencySafe } = def;
  return lockKey
    ? createLockedSweep({
      name,
      lockKey,
      intervalMs,
      runOnStart,
      run,
      ...(concurrencySafe !== undefined ? { concurrencySafe } : {}),
    })
    : createScheduler({ name, intervalMs, runOnStart, run });
}

/** The sweeps that apply to this deployment. */
export async function sweepDefinitions(): Promise<SweepDefinition[]> {
  const defs: SweepDefinition[] = [];

  // Publish the on-call ROTA COVERAGE gauge: is anyone scheduled over the next
  // ONCALL_SCHEDULE_GAP_LOOKAHEAD_HOURS. This is the absence check the whole
  // paging feature is otherwise missing — every other signal here reports that
  // something HAPPENED, and a rota with a hole next Tuesday produces no signal
  // at all until 02:00 Tuesday.
  //
  // Opt-in on its own credential, and that is a security property rather than a
  // convenience: reading the rota needs a REST API token, which is account-wide
  // over incidents, schedules and users, where the per-service integration key
  // used for SENDING can only create events on one service. A deployment that
  // will not hand over the stronger token simply does not get the gauge — it
  // must never be inferred from the routing key.
  const { onCallInboundConfig } = await import('@pipeline-builder/api-core');
  if (onCallInboundConfig().apiToken) {
    const { publishRotaCoverage } = await import('./oncall-rota.js');
    defs.push({
      name: 'oncall-rota-coverage',
      lockKey: leaderLockKey('ops-center', 'oncall-rota-coverage'),
      // A read plus a gauge write. Every replica would publish the identical
      // number, so there is nothing to serialize — but it is leader-locked
      // anyway to keep one deployment from spending N replicas' worth of a
      // rate-limited third-party API on one answer.
      concurrencySafe: true,
      intervalMs: config.oncall.rotaIntervalMs,
      run: async () => { await publishRotaCoverage(); },
    });
  }

  // Alert delivery health gauges (every replica), the status table's 30-day
  // retention, and the soft-delete retention purge of dashboards / alert rules /
  // alert destinations.
  const [{ deliveryHealthSweep, deliveryStatusRetentionSweep }, { softDeletePurgeSweep }] = await Promise.all([
    import('./alert-delivery-status.js'),
    import('./soft-delete-purge.js'),
  ]);
  defs.push(deliveryHealthSweep(), deliveryStatusRetentionSweep(), softDeletePurgeSweep);
  return defs;
}

/**
 * Build and start every applicable sweep. Returns the started schedulers so the
 * caller can stop them on shutdown. A sweep that fails to build is logged and
 * skipped — one broken sweep must not keep the rest (or the service) down.
 */
export async function registerBackgroundSweeps(): Promise<Scheduler[]> {
  const started: Scheduler[] = [];
  for (const def of await sweepDefinitions()) {
    try {
      const sweep = buildSweep(def);
      if (!sweep) continue;
      sweep.start();
      started.push(sweep);
    } catch (err) {
      logger.error('Background sweep failed to start', { name: def.name, error: errorMessage(err) });
    }
  }
  logger.info('Background sweeps started', { sweeps: started.length });
  return started;
}
