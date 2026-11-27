// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The daily-rollup scheduler's knobs are bounded like every sibling scheduler.
 * Unbounded, `REPORTING_ROLLUP_INTERVAL_MINUTES=0` ran the rollup back to back,
 * a negative startup delay scheduled into the past, and a lock TTL of 0 meant
 * no leader lock at all, so every replica rolled up at once.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { config } from '../src/config.js';

const KEYS = ['REPORTING_ROLLUP_INTERVAL_MINUTES', 'REPORTING_ROLLUP_STARTUP_DELAY_MS', 'REPORTING_ROLLUP_LOCK_TTL_MS'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('rollup scheduler bounds', () => {
  it('runs at most once a minute', () => {
    process.env.REPORTING_ROLLUP_INTERVAL_MINUTES = '0';
    expect(config.rollup.intervalMs).toBe(60_000);
    process.env.REPORTING_ROLLUP_INTERVAL_MINUTES = '-5';
    expect(config.rollup.intervalMs).toBe(60_000);
  });

  it('never schedules the first run in the past', () => {
    process.env.REPORTING_ROLLUP_STARTUP_DELAY_MS = '-1000';
    expect(config.rollup.startupDelayMs).toBe(0);
  });

  it('keeps a real leader lock (at least a second)', () => {
    process.env.REPORTING_ROLLUP_LOCK_TTL_MS = '0';
    expect(config.rollup.lockTtlMs).toBe(1000);
  });

  it('leaves in-range values alone', () => {
    process.env.REPORTING_ROLLUP_INTERVAL_MINUTES = '15';
    process.env.REPORTING_ROLLUP_STARTUP_DELAY_MS = '5000';
    process.env.REPORTING_ROLLUP_LOCK_TTL_MS = '30000';
    expect(config.rollup).toMatchObject({ intervalMs: 900_000, startupDelayMs: 5000, lockTtlMs: 30_000 });
  });
});
