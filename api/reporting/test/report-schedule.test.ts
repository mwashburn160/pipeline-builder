// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * When a definition next runs.
 *
 * Its own suite because its own module: the AUTHORING routes derive the schedule too, and a
 * definition with no `next_run_at` never becomes due at all — the gap that made every
 * definition in the feature permanently dormant before this phase.
 *
 * The jitter is the interesting part. It exists because every weekly definition in the
 * fleet comes due at the same calendar instant, and it is DERIVED FROM THE ID rather than
 * random so that a lead who notices their report lands around 07:20 does not find it at
 * 06:05 next week.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  nextPeriodBoundary: () => new Date('2026-09-28T05:00:00.000Z'),
}));

const schedule = await import('../src/services/report-schedule.js');

const NOW = new Date('2026-09-21T12:00:00.000Z');

const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1',
  orgId: 'acme',
  cadence: 'weekly',
  timezone: 'America/Chicago',
  weekStart: 'monday',
  ...over,
}) as never;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick'] });
  delete process.env.REPORT_JITTER_MS;
  delete process.env.REPORT_SETTLE_HOURS;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('nextRunFor', () => {
  it('is the period boundary plus the settle delay plus a jitter', () => {
    process.env.REPORT_JITTER_MS = '0';
    const at = schedule.nextRunFor(definition() as never, NOW);
    // Boundary 2026-09-28T05:00Z + 6h settle, with jitter switched off.
    expect(at.toISOString()).toBe('2026-09-28T11:00:00.000Z');
  });

  it('gives the SAME definition the same offset every period', () => {
    const a = schedule.nextRunFor(definition() as never, NOW);
    const b = schedule.nextRunFor(definition() as never, new Date('2026-09-22T00:00:00Z'));
    // Derived from the id, not Math.random(): a lead who notices their report lands
    // around 07:20 should not find it at 06:05 next week.
    expect(a.getTime()).toBe(b.getTime());
  });

  it('gives DIFFERENT definitions different offsets', () => {
    const a = schedule.nextRunFor(definition({ id: 'def-1' }) as never, NOW);
    const b = schedule.nextRunFor(definition({ id: 'def-zzzz' }) as never, NOW);
    // The whole point: every weekly definition in the fleet comes due at the same
    // calendar instant, and they must not all compose at once.
    expect(a.getTime()).not.toBe(b.getTime());
  });

  it('keeps the jitter inside the configured span', () => {
    process.env.REPORT_JITTER_MS = '60000';
    const base = new Date('2026-09-28T11:00:00.000Z').getTime();
    for (const id of ['a', 'bb', 'ccc', 'dddd', 'def-1', 'def-zzzz']) {
      const at = schedule.nextRunFor(definition({ id }) as never, NOW).getTime();
      expect(at).toBeGreaterThanOrEqual(base);
      expect(at).toBeLessThan(base + 60_000);
    }
  });
});

describe('reportSettleHours', () => {
  it('defaults to six, matching the rollup settle delay', () => {
    // A report that ran ahead of the rollup would read a half-built day.
    expect(schedule.reportSettleHours()).toBe(6);
  });
});
