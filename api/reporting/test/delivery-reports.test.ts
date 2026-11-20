// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Delivery routes (/reports/delivery/runners and /calendar).
 *
 * Pinned: /runners is FREE (no feature gate — `reports:read` at the mount),
 * /calendar is `advanced_reporting` (tagged on the route, like /dora); the
 * interval / tz / weekStart validation; date-only bounds read as local
 * midnights in tz; the retention cap (event retention for runners, DORA
 * retention for the calendar); and the rollup gate. The numbers themselves are
 * tested against a real Postgres in pipeline-data's delivery-reports.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRunners = jest.fn<AnyFn>();
const mockCalendar = jest.fn<AnyFn>();
const mockResolveOrgRollup = jest.fn<AnyFn>();
const mockGetReportingSettings = jest.fn<AnyFn>();
const permCheck = (req: any, perm: string) =>
  req?.user?.isSuperAdmin === true || (req?.user?.permissions ?? []).includes(perm);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn<AnyFn>(),
  sendBadRequest: jest.fn<AnyFn>(),
  getServiceAuthHeader: jest.fn(() => ({})),
  userHasPermission: jest.fn(permCheck),
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
  return {
    ...actual,
    rollupIds: (req: any, orgId: string) =>
      req?.query?.includeDescendants === 'true' && permCheck(req, 'reports:rollup')
        ? mockResolveOrgRollup(orgId)
        : Promise.resolve(undefined),
  };
});

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as typeof import('@pipeline-builder/pipeline-data');
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: { getReportingSettings: mockGetReportingSettings },
  getRunnerReliability: mockRunners,
  getDeploymentCalendar: mockCalendar,
  securityBound: actualData.securityBound,
}));

const { sendSuccess, sendBadRequest } = await import('@pipeline-builder/api-core');
const { createDeliveryReportRoutes } = await import('../src/routes/delivery-reports.js');

const UNLIMITED = { eventRetentionDays: -1, doraRetentionDays: -1, defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180 };

let router: any;
const stackOf = (path: string) => router.stack.find((l: any) => l.route?.path === path)?.route?.stack;
const handlerOf = (path: string) => { const s = stackOf(path); return s[s.length - 1].handle; };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetReportingSettings.mockResolvedValue(UNLIMITED);
  mockRunners.mockResolvedValue({ ok: 'runners' });
  mockCalendar.mockResolvedValue({ ok: 'calendar' });
  router = createDeliveryReportRoutes();
});

describe('GET /reports/delivery/runners', () => {
  it('is free: no feature gate on the route', () => {
    const gates = stackOf('/runners').slice(0, -1).map((l: any) => l.handle.__feature).filter(Boolean);
    expect(gates).toEqual([]);
  });

  it('reads date-only bounds as local midnights in tz and passes the bucketing through', async () => {
    await handlerOf('/runners')({ query: { from: '2026-09-01', to: '2026-10-01', interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' } }, {});
    expect(mockRunners).toHaveBeenCalledWith(
      { orgId: 'acme', from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z' },
      { interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' },
    );
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { runners: { ok: 'runners' } });
  });

  it('400s a bad interval or timezone without querying', async () => {
    await handlerOf('/runners')({ query: { interval: 'fortnight' } }, {});
    await handlerOf('/runners')({ query: { tz: 'Mars/Olympus' } }, {});
    expect(sendBadRequest).toHaveBeenCalledTimes(2);
    expect(mockRunners).not.toHaveBeenCalled();
  });

  it('is capped by EVENT retention', async () => {
    mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, eventRetentionDays: 30, doraRetentionDays: -1 });
    await handlerOf('/runners')({ query: { from: '2025-01-01', to: '2026-01-01' } }, {});
    expect(sendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/exceeds maximum/), expect.anything());
    expect(mockRunners).not.toHaveBeenCalled();
  });

  it('rolls up over the team subtree only for a reports:rollup holder', async () => {
    mockResolveOrgRollup.mockResolvedValue(['acme', 'team-1']);
    await handlerOf('/runners')({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});
    expect(mockRunners).toHaveBeenLastCalledWith(expect.objectContaining({ orgIds: ['acme', 'team-1'] }), expect.anything());
    await handlerOf('/runners')({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:read'] } }, {});
    expect(mockRunners).toHaveBeenLastCalledWith(expect.not.objectContaining({ orgIds: expect.anything() }), expect.anything());
  });
});

describe('GET /reports/delivery/calendar', () => {
  it('is gated on advanced_reporting, like /execution/dora', () => {
    const gates = stackOf('/calendar').slice(0, -1).map((l: any) => l.handle.__feature);
    expect(gates).toEqual(['advanced_reporting']);
  });

  it('counts days in tz, with date-only bounds as local midnights', async () => {
    await handlerOf('/calendar')({ query: { from: '2026-09-01', to: '2026-10-01', tz: 'America/Chicago' } }, {});
    expect(mockCalendar).toHaveBeenCalledWith(
      { orgId: 'acme', from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z' },
      { tz: 'America/Chicago' },
    );
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { calendar: { ok: 'calendar' } });
  });

  it('400s a bad timezone without querying', async () => {
    await handlerOf('/calendar')({ query: { tz: 'Mars/Olympus' } }, {});
    expect(sendBadRequest).toHaveBeenCalledTimes(1);
    expect(mockCalendar).not.toHaveBeenCalled();
  });

  it('is capped by DORA retention, not event retention', async () => {
    mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, eventRetentionDays: 30, doraRetentionDays: -1 });
    await handlerOf('/calendar')({ query: { from: '2025-06-01', to: '2026-01-01' } }, {});
    expect(mockCalendar).toHaveBeenCalled();
    mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, eventRetentionDays: -1, doraRetentionDays: 30 });
    await handlerOf('/calendar')({ query: { from: '2025-01-01', to: '2026-01-01' } }, {});
    expect(sendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/exceeds maximum/), expect.anything());
  });

  it('rolls up only for a reports:rollup holder', async () => {
    mockResolveOrgRollup.mockResolvedValue(['acme', 'team-1']);
    await handlerOf('/calendar')({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});
    expect(mockCalendar).toHaveBeenLastCalledWith(expect.objectContaining({ orgIds: ['acme', 'team-1'] }), expect.anything());
  });
});
