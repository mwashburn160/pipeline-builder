// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /reports/benchmark/teams — the Teams tab.
 *
 * Pinned here: the gates (reports:rollup + advanced_reporting on the route, as a
 * rollup read and /dora carry them); the strict subtree resolution (a platform
 * outage is a 503, not a one-row "no teams" table); the no-teams answer (nothing
 * queried); that each window is the dashboard's own (DORA vs event retention);
 * tz/weekStart validation; and that names are best-effort. The row parity with a
 * team's own dashboard is tested against a real Postgres in pipeline-data's
 * team-benchmark.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCompute = jest.fn<AnyFn>();
const mockSubtree = jest.fn<AnyFn>();
const mockNames = jest.fn<AnyFn>();
const mockGetReportingSettings = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn<AnyFn>(),
  sendBadRequest: jest.fn<AnyFn>(),
  sendError: jest.fn<AnyFn>(),
  getServiceAuthHeader: jest.fn(() => ({})),
  fetchOrgNames: mockNames,
  requirePermission: (perm: string) => Object.assign((_q: any, _s: any, next: any) => next && next(), { __permission: perm }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn() }, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

jest.unstable_mockModule('../src/helpers/report-helpers.js', () => {
  const actual = jest.requireActual('../src/helpers/report-helpers.js') as Record<string, unknown>;
  return { ...actual, resolveOrgSubtree: mockSubtree };
});

const reportingService = { getReportingSettings: mockGetReportingSettings };
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService,
  computeTeamBenchmark: mockCompute,
}));

const { sendSuccess, sendBadRequest, sendError } = await import('@pipeline-builder/api-core');
const { createBenchmarkReportRoutes } = await import('../src/routes/benchmark-reports.js');

const UNLIMITED = { incidentWindowHours: null, defaultWindowHours: 24, eventRetentionDays: -1, doraRetentionDays: -1, defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180 };
const RESULT = { window: {}, rows: [{ orgId: 'acme' }, { orgId: 'team-1' }] };

describe('GET /reports/benchmark/teams', () => {
  let router: any;
  const stack = () => router.stack.find((l: any) => l.route?.path === '/teams')?.route?.stack;
  const handler = () => stack()[stack().length - 1].handle;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReportingSettings.mockResolvedValue(UNLIMITED);
    mockSubtree.mockResolvedValue(['acme', 'team-1']);
    mockNames.mockResolvedValue({ 'team-1': 'Payments' });
    mockCompute.mockResolvedValue(RESULT);
    router = createBenchmarkReportRoutes();
  });

  it('is gated on reports:rollup and advanced_reporting, like a rollup read and /dora', () => {
    const gates = stack().slice(0, -1).map((l: any) => l.handle.__permission ?? l.handle.__feature);
    expect(gates).toEqual(['reports:rollup', 'advanced_reporting']);
  });

  it('builds one row per team plus the org, in the dashboard windows and bucketing', async () => {
    await handler()({ query: { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', tz: 'America/Chicago', weekStart: 'sunday' } }, {});
    expect(mockSubtree).toHaveBeenCalledWith('acme');
    expect(mockCompute).toHaveBeenCalledWith(reportingService, {
      parentOrgId: 'acme',
      orgIds: ['acme', 'team-1'],
      names: { 'team-1': 'Payments' },
      doraRange: { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
      eventRange: { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
      interval: 'week',
      tz: 'America/Chicago',
      weekStart: 'sunday',
    });
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { benchmark: { hasTeams: true, ...RESULT } });
  });

  it('floors each window to its own retention (DORA vs standard events), as the dashboard routes do', async () => {
    mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, eventRetentionDays: 30, doraRetentionDays: 180 });
    const now = Date.now();
    const from = new Date(now - 60 * 86_400_000).toISOString();
    const to = new Date(now).toISOString();
    // 60 days is past the 30-day event cap → the range is refused like /success-rate would refuse it.
    await handler()({ query: { from, to } }, {});
    expect(sendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/exceeds maximum/), expect.anything());
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it('answers hasTeams: false for an org without teams and queries nothing', async () => {
    mockSubtree.mockResolvedValue(undefined);
    await handler()({ query: {} }, {});
    expect(mockCompute).not.toHaveBeenCalled();
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { benchmark: { hasTeams: false, rows: [] } });
  });

  it('503s when the hierarchy cannot be resolved (never a misleading one-row table)', async () => {
    mockSubtree.mockRejectedValue(new Error('platform down'));
    await handler()({ query: {} }, {});
    expect(sendError).toHaveBeenCalledWith(expect.anything(), 503, expect.any(String), expect.anything());
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it('renders ids when the name lookup fails', async () => {
    mockNames.mockRejectedValue(new Error('timeout'));
    await handler()({ query: {} }, {});
    expect(mockCompute).toHaveBeenCalledWith(reportingService, expect.objectContaining({ names: {} }));
  });

  it('400s an invalid timezone or interval without querying', async () => {
    await handler()({ query: { tz: 'Mars/Olympus' } }, {});
    await handler()({ query: { interval: 'hour' } }, {});
    expect(sendBadRequest).toHaveBeenCalledTimes(2);
    expect(mockSubtree).not.toHaveBeenCalled();
  });
});
