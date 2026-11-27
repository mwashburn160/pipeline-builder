// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stuck-publish RESUME scheduler for nightly toolchain fixes: every
 * TOOLCHAIN_FIX_RESUME_INTERVAL_MS (default 2 min, at least 30 s), on the one
 * replica that wins the leader lock, it resumes every approved toolchain
 * candidate whose publish crashed without releasing its 5-minute lease
 * (`resumeStuckToolchainFixes`, the same idempotent publish as a repeat
 * approve). The nightly pass still calls it as a backstop.
 *
 * Not built at all — and a tick does nothing — while PLUGIN_REMEDIATION_ENABLED
 * is false or PLUGIN_REMEDIATION_TOOLCHAINS is off. Each tick counts
 * `toolchain_fix_resume_runs_total{outcome}` (resumed | idle | skipped | error);
 * a resume that fails part-way is counted by `toolchain_fix_failures_total`
 * (alerted) inside the publish itself. Never throws.
 */

import {
  createLogger, createScheduler, DEFAULT_LEADER_LOCK_TTL_MS, errorMessage, leaderLockKey,
  TOOLCHAIN_FIX_METRICS, type LockRedis, type Scheduler,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';

import { config, remediationConfig } from '../../config.js';

const logger = createLogger('toolchain-fix-resume');
const LOCK_KEY = leaderLockKey('plugin', 'toolchain-fix-resume');

export type ResumeTickOutcome = 'resumed' | 'idle' | 'skipped' | 'error';

export interface ToolchainResumeDeps {
  /** Resume the stuck publishes; answers how many finished (default: the live ports). */
  resume?: () => Promise<number>;
}

/** TOOLCHAIN_FIX_RESUME_INTERVAL_MS, at least 30 s. */
export function toolchainResumeIntervalMs(): number {
  return config.operator.toolchainFixResumeIntervalMs;
}

const knobsOn = (): boolean => {
  const cfg = remediationConfig();
  return cfg.enabled && cfg.toolchains !== 'off';
};

async function liveResume(): Promise<number> {
  const [{ resumeStuckToolchainFixes }, { liveToolchainPorts }] = await Promise.all([import('./toolchain.js'), import('./tooling.js')]);
  return resumeStuckToolchainFixes({ ports: liveToolchainPorts() });
}

/** One tick (exported for tests). */
export async function runToolchainResumeTick(deps: ToolchainResumeDeps = {}): Promise<ResumeTickOutcome> {
  let outcome: ResumeTickOutcome;
  if (!knobsOn()) {
    outcome = 'skipped';
  } else {
    try {
      outcome = (await (deps.resume ?? liveResume)()) > 0 ? 'resumed' : 'idle';
    } catch (err) {
      logger.warn('Toolchain fix resume tick failed', { error: errorMessage(err) });
      outcome = 'error';
    }
  }
  incCounter(TOOLCHAIN_FIX_METRICS.resumeRuns, { outcome });
  return outcome;
}

/**
 * Build (not start) the scheduler, leader-locked on the shared Redis when
 * `redis` is given (index.ts); null while either knob is off.
 */
export function createToolchainResumeScheduler(deps: ToolchainResumeDeps & { redis?: () => LockRedis; startupDelayMs?: number } = {}): Scheduler | null {
  if (!knobsOn()) return null;
  return createScheduler({
    name: 'toolchain-fix-resume',
    intervalMs: toolchainResumeIntervalMs(),
    startupDelayMs: deps.startupDelayMs ?? 60_000,
    ...(deps.redis ? { lock: { redis: deps.redis, key: LOCK_KEY, ttlMs: DEFAULT_LEADER_LOCK_TTL_MS } } : {}),
    run: async () => { await runToolchainResumeTick(deps); },
  });
}
