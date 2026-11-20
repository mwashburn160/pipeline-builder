// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `?compare=previous` on the dashboard headline routes (/dora, /success-rate).
 *
 * Pinned here: both windows come back; the previous window is the equal-length
 * closed window ending just before `from`; it is null when it would start before
 * the retention horizon; a bad value is a 400; and the comparison is an
 * `advanced_reporting` read — a free-tier caller of the free /success-rate route
 * gets no comparison (403 when asked), while the plain route stays free.
 *
 * The route's FULL middleware chain is driven (not just the last handler), with
 * a feature gate that really checks `req.user.features`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetSuccessRate = jest.fn<AnyFn>();
const mockGetDoraMetrics = jest.fn<AnyFn>();
const mockGetReportingSettings = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn<AnyFn>(),
  sendBadRequest: jest.fn<AnyFn>(),
  getServiceAuthHeader: jest.fn(() => ({})),
  userHasPermission: jest.fn(() => false),
  // A behavioral feature gate: entitled (or superadmin) passes, anyone else is refused.
  requireFeature: (feature: string) => Object.assign(
    (req: any, res: any, next: any) => {
      if (req.user?.isSuperAdmin === true || (req.user?.features ?? []).includes(feature)) return next();
      res.denied = feature;
    },
    { __feature: feature },
  ),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn() }, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as typeof import('@pipeline-builder/pipeline-data');
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {
    getSuccessRate: mockGetSuccessRate,
    getDoraMetrics: mockGetDoraMetrics,
    getReportingSettings: mockGetReportingSettings,
  },
  previousDashboardWindow: actualData.previousDashboardWindow,
}));

const { sendSuccess, sendBadRequest } = await import('@pipeline-builder/api-core');
const { createExecutionReportRoutes } = await import('../src/routes/execution-reports.js');

const UNLIMITED = {
  incidentWindowHours: null,
  defaultWindowHours: 24,
  eventRetentionDays: -1,
  doraRetentionDays: -1,
  defaultEventRetentionDays: 30,
  defaultDoraRetentionDays: 180,
};
const ENTITLED = { features: ['advanced_reporting'], permissions: ['reports:read'] };
const FREE = { features: [], permissions: ['reports:read'] };
const FROM = '2026-11-11T00:00:00.000Z';
const TO = '2026-11-21T00:00:00.000Z';
const PREV = { from: '2026-10-31T23:59:59.999Z', to: '2026-11-10T23:59:59.999Z' };

describe('?compare=previous', () => {
  let router: any;
  /** Run the route's whole chain the way Express would; returns the res. */
  const call = async (path: string, req: any) => {
    const stack = router.stack.find((l: any) => l.route?.path === path).route.stack;
    const res: any = {};
    for (const layer of stack) {
      let advanced = false;
      await layer.handle(req, res, () => { advanced = true; });
      if (!advanced && layer !== stack[stack.length - 1]) break;
    }
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReportingSettings.mockResolvedValue(UNLIMITED);
    mockGetSuccessRate.mockImplementation(async (_o: string, _i: string, from: string) => [{ period: from, succeeded: 1, failed: 0, canceled: 0, success_pct: 100 }]);
    mockGetDoraMetrics.mockImplementation(async (_o: string, from: string, to: string) => ({ window: { from, to } }));
    router = createExecutionReportRoutes();
  });

  describe('GET /success-rate', () => {
    it('returns the range and the equal-length window just before it', async () => {
      await call('/success-rate', { query: { from: FROM, to: TO, compare: 'previous', tz: 'America/Chicago' }, user: ENTITLED });
      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'week', FROM, TO, undefined, { tz: 'America/Chicago', weekStart: 'monday' });
      expect(mockGetSuccessRate).toHaveBeenCalledWith('acme', 'week', PREV.from, PREV.to, undefined, { tz: 'America/Chicago', weekStart: 'monday' });
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, {
        timeline: [expect.objectContaining({ period: FROM })],
        previous: { window: PREV, timeline: [expect.objectContaining({ period: PREV.from })] },
      });
    });

    it('stays free and single-window without ?compare', async () => {
      await call('/success-rate', { query: { from: FROM, to: TO }, user: FREE });
      expect(mockGetSuccessRate).toHaveBeenCalledTimes(1);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { timeline: expect.any(Array) });
    });

    it('gives the free tier no comparison: refused, and nothing is queried', async () => {
      const res = await call('/success-rate', { query: { from: FROM, to: TO, compare: 'previous' }, user: FREE });
      expect(res.denied).toBe('advanced_reporting');
      expect(mockGetSuccessRate).not.toHaveBeenCalled();
      expect(sendSuccess).not.toHaveBeenCalled();
    });

    it('answers previous: null when the previous window starts before the event retention horizon', async () => {
      mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, eventRetentionDays: 30 });
      const now = Date.now();
      const from = new Date(now - 20 * 86_400_000).toISOString();
      const to = new Date(now).toISOString();
      await call('/success-rate', { query: { from, to, compare: 'previous' }, user: ENTITLED });
      expect(mockGetSuccessRate).toHaveBeenCalledTimes(1);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { timeline: expect.any(Array), previous: null });
    });

    it('reads the retention settings once, so no current-window query is left in flight by a second read', async () => {
      await call('/success-rate', { query: { from: FROM, to: TO, compare: 'previous' }, user: ENTITLED });
      expect(mockGetReportingSettings).toHaveBeenCalledTimes(1);
      expect(mockGetSuccessRate).toHaveBeenCalledTimes(2);
    });

    it('400s an unknown compare value', async () => {
      await call('/success-rate', { query: { compare: 'last-year' }, user: ENTITLED });
      expect(sendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('compare'), expect.anything());
      expect(mockGetSuccessRate).not.toHaveBeenCalled();
    });
  });

  describe('GET /dora', () => {
    it('returns both windows with the same scoping and incident window', async () => {
      mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, incidentWindowHours: 6 });
      await call('/dora', { query: { from: FROM, to: TO, compare: 'previous', environment: 'staging' }, user: ENTITLED });
      const opts = { pipelineId: undefined, environment: 'staging', incidentWindowHours: 6 };
      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', FROM, TO, undefined, opts);
      expect(mockGetDoraMetrics).toHaveBeenCalledWith('acme', PREV.from, PREV.to, undefined, opts);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, {
        dora: { window: { from: FROM, to: TO } },
        previous: { window: PREV },
      });
    });

    it('keeps the plain response shape without ?compare', async () => {
      await call('/dora', { query: { from: FROM, to: TO }, user: ENTITLED });
      expect(mockGetDoraMetrics).toHaveBeenCalledTimes(1);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { dora: { window: { from: FROM, to: TO } } });
    });

    it('is refused to the free tier, compare or not', async () => {
      const res = await call('/dora', { query: { compare: 'previous' }, user: FREE });
      expect(res.denied).toBe('advanced_reporting');
      expect(mockGetDoraMetrics).not.toHaveBeenCalled();
    });

    it('answers previous: null when the previous window is past the DORA retention horizon', async () => {
      mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, doraRetentionDays: 30 });
      const now = Date.now();
      await call('/dora', {
        query: { from: new Date(now - 20 * 86_400_000).toISOString(), to: new Date(now).toISOString(), compare: 'previous' },
        user: ENTITLED,
      });
      expect(mockGetDoraMetrics).toHaveBeenCalledTimes(1);
      expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ previous: null }));
    });
  });
});
