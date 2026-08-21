// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-org retention window (Phase 8 + D4). The window carries BOTH:
 *  - `maxRangeMs` — the [from,to] WIDTH cap (narrows the absolute 730-day ceiling
 *    to the org's effective retention entitlement; `-1` unlimited → the ceiling).
 *  - `minFromMs`  — the `from` FLOOR (`now − effectiveRetentionDays·day`; `-1`
 *    unlimited → `0` = no floor).
 * Routes apply BOTH so the returned window reflects the retention horizon, not
 * just its width.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetIncidentSettings = jest.fn<(...a: unknown[]) => Promise<unknown>>();

// helpers.ts (transitively imported for MAX_REPORT_RANGE_DAYS) links against
// `userHasPermission`, which the base mock omits — provide a stub so the module
// graph resolves.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  userHasPermission: jest.fn(() => false),
}));

// helpers.ts (imported transitively by retention-cap.ts for MAX_REPORT_RANGE_DAYS)
// pulls `Config` from pipeline-core — stub it so the full config graph
// (aws-cdk-lib, etc.) stays out of this suite.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: { getIncidentSettings: mockGetIncidentSettings },
}));

const { orgRetentionWindowFromSettings, resolveOrgRetentionWindow, floorFrom, parseOrgReportRange } =
  await import('../src/helpers/retention-cap.js');

const DAY_MS = 86_400_000;
// A fixed clock so minFromMs is deterministic: 2026-08-20T00:00:00Z.
const NOW = Date.parse('2026-08-20T00:00:00Z');
// The env defaults reporting seeds when an org has no per-org override.
const DEFAULTS = { defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180 };

describe('orgRetentionWindowFromSettings — width cap', () => {
  it('a default org caps dora at 180 days and events at 30 days', () => {
    const s = { eventRetentionDays: null, doraRetentionDays: null, ...DEFAULTS };
    expect(orgRetentionWindowFromSettings(s, 'dora', NOW).maxRangeMs).toBe(180 * DAY_MS);
    expect(orgRetentionWindowFromSettings(s, 'event', NOW).maxRangeMs).toBe(30 * DAY_MS);
  });

  it('a `-1` (unlimited) override clamps the width to the 730-day ceiling, never infinity', () => {
    const s = { eventRetentionDays: -1, doraRetentionDays: -1, ...DEFAULTS };
    expect(orgRetentionWindowFromSettings(s, 'dora', NOW).maxRangeMs).toBe(730 * DAY_MS);
    expect(orgRetentionWindowFromSettings(s, 'event', NOW).maxRangeMs).toBe(730 * DAY_MS);
  });

  it('a bundle-extended override widens the width to that value; an over-ceiling one clamps to 730', () => {
    expect(orgRetentionWindowFromSettings({ eventRetentionDays: null, doraRetentionDays: 545, ...DEFAULTS }, 'dora', NOW).maxRangeMs).toBe(545 * DAY_MS);
    expect(orgRetentionWindowFromSettings({ eventRetentionDays: 900, doraRetentionDays: null, ...DEFAULTS }, 'event', NOW).maxRangeMs).toBe(730 * DAY_MS);
  });

  it('the override wins over the default when both are present', () => {
    const s = { eventRetentionDays: 90, doraRetentionDays: 365, ...DEFAULTS };
    expect(orgRetentionWindowFromSettings(s, 'event', NOW).maxRangeMs).toBe(90 * DAY_MS);
    expect(orgRetentionWindowFromSettings(s, 'dora', NOW).maxRangeMs).toBe(365 * DAY_MS);
  });
});

describe('orgRetentionWindowFromSettings — from floor (minFromMs)', () => {
  it('floors at now − effectiveRetentionDays for a bounded retention', () => {
    const s = { eventRetentionDays: null, doraRetentionDays: null, ...DEFAULTS };
    expect(orgRetentionWindowFromSettings(s, 'dora', NOW).minFromMs).toBe(NOW - 180 * DAY_MS);
    expect(orgRetentionWindowFromSettings(s, 'event', NOW).minFromMs).toBe(NOW - 30 * DAY_MS);
  });

  it('a `-1` (unlimited) override drops the floor entirely (minFromMs = 0)', () => {
    const s = { eventRetentionDays: -1, doraRetentionDays: -1, ...DEFAULTS };
    expect(orgRetentionWindowFromSettings(s, 'dora', NOW).minFromMs).toBe(0);
    expect(orgRetentionWindowFromSettings(s, 'event', NOW).minFromMs).toBe(0);
  });

  it('an override floor wins over the default', () => {
    const s = { eventRetentionDays: 90, doraRetentionDays: null, ...DEFAULTS };
    expect(orgRetentionWindowFromSettings(s, 'event', NOW).minFromMs).toBe(NOW - 90 * DAY_MS);
  });
});

describe('floorFrom', () => {
  const to = '2026-08-20T00:00:00Z';
  it('raises `from` up to the floor when it precedes the retention horizon', () => {
    const minFromMs = Date.parse('2026-07-01T00:00:00Z');
    const out = floorFrom({ from: '2026-01-01T00:00:00Z', to }, minFromMs);
    expect(Date.parse(out.from)).toBe(minFromMs);
    expect(out.to).toBe(to);
  });

  it('leaves `from` untouched when it is already within the horizon', () => {
    const minFromMs = Date.parse('2026-07-01T00:00:00Z');
    const range = { from: '2026-08-01T00:00:00Z', to };
    expect(floorFrom(range, minFromMs)).toEqual(range);
  });

  it('does NOT floor when unlimited (minFromMs = 0)', () => {
    const range = { from: '2020-01-01T00:00:00Z', to };
    expect(floorFrom(range, 0)).toEqual(range);
  });

  it('never moves `from` past `to` (whole window before retention → zero-width)', () => {
    const minFromMs = Date.parse('2026-08-25T00:00:00Z'); // after `to`
    const out = floorFrom({ from: '2026-01-01T00:00:00Z', to }, minFromMs);
    expect(Date.parse(out.from)).toBe(Date.parse(to));
  });
});

describe('resolveOrgRetentionWindow (fetch + compute)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads the org settings and returns the computed dora window', async () => {
    mockGetIncidentSettings.mockResolvedValue({ eventRetentionDays: null, doraRetentionDays: 545, ...DEFAULTS });
    const win = await resolveOrgRetentionWindow('acme', 'dora', NOW);
    expect(mockGetIncidentSettings).toHaveBeenCalledWith('acme');
    expect(win.maxRangeMs).toBe(545 * DAY_MS);
    expect(win.minFromMs).toBe(NOW - 545 * DAY_MS);
  });
});

describe('parseOrgReportRange (cap + floor)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('floors an over-retention `from` up to the horizon', async () => {
    mockGetIncidentSettings.mockResolvedValue({ eventRetentionDays: null, doraRetentionDays: null, ...DEFAULTS });
    // A narrow 10-day window (within the 180-day dora WIDTH cap) but entirely
    // OLDER than the 180-day floor → `from` is raised up to the horizon.
    const from = new Date(Date.now() - 200 * DAY_MS).toISOString();
    const to = new Date(Date.now() - 190 * DAY_MS).toISOString();
    const range = await parseOrgReportRange({ from, to }, 'acme', 'dora');
    if ('error' in range) throw new Error(range.error);
    expect(Date.parse(range.from)).toBeGreaterThan(Date.parse(from));
  });

  it('does NOT floor for an unlimited (-1) org', async () => {
    mockGetIncidentSettings.mockResolvedValue({ eventRetentionDays: -1, doraRetentionDays: -1, ...DEFAULTS });
    const from = '2020-01-01T00:00:00Z';
    const range = await parseOrgReportRange({ from, to: '2020-06-01T00:00:00Z' }, 'acme', 'event');
    if ('error' in range) throw new Error(range.error);
    expect(range.from).toBe(from);
  });

  it('propagates a width-cap error from parseDateRange (over-cap range rejected)', async () => {
    mockGetIncidentSettings.mockResolvedValue({ eventRetentionDays: 30, doraRetentionDays: null, ...DEFAULTS });
    const range = await parseOrgReportRange(
      { from: '2026-01-01T00:00:00Z', to: '2026-08-01T00:00:00Z' }, // ~7 months > 30-day cap
      'acme',
      'event',
    );
    expect('error' in range).toBe(true);
  });
});
