// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the read-only effective-retention route (`GET /reports/retention`).
 * It resolves the per-org override against the env default for BOTH windows and
 * reports the widest servable range (the horizon clamped to the 730-day report
 * ceiling; `-1` unlimited → the ceiling).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockGetSettings = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  userHasPermission: jest.fn(() => false),
}));

// report-helpers (pulled in via retention-cap for MAX_REPORT_RANGE_DAYS) reads Config.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: { getReportingSettings: (...a: unknown[]) => mockGetSettings(...a) },
}));

const { createRetentionRoutes } = await import('../src/routes/retention.js');

const DEFAULTS = { incidentWindowHours: null, defaultWindowHours: 24, defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180 };

describe('GET /reports/retention', () => {
  const handler = () => {
    const router: any = createRetentionRoutes();
    const stack = router.stack.find((l: any) => l.route?.path === '/' && l.route?.methods.get)?.route?.stack;
    return stack[stack.length - 1].handle;
  };
  const payload = () => mockSendSuccess.mock.calls[0][2];

  beforeEach(() => { jest.clearAllMocks(); });

  it('falls back to the env defaults when the org has no override', async () => {
    mockGetSettings.mockResolvedValue({ ...DEFAULTS, eventRetentionDays: null, doraRetentionDays: null });
    await handler()({ query: {} }, {});
    expect(mockGetSettings).toHaveBeenCalledWith('acme', 'acme');
    expect(payload().retention).toEqual({
      eventRetentionDays: 30, doraRetentionDays: 180, eventMaxRangeDays: 30, doraMaxRangeDays: 180,
    });
  });

  it('reports a Retention-Pack override for standard events (the non-DORA case)', async () => {
    mockGetSettings.mockResolvedValue({ ...DEFAULTS, eventRetentionDays: 120, doraRetentionDays: null });
    await handler()({ query: {} }, {});
    expect(payload().retention).toMatchObject({ eventRetentionDays: 120, eventMaxRangeDays: 120 });
  });

  it('clamps the servable range to the 730-day ceiling and keeps -1 as unlimited', async () => {
    mockGetSettings.mockResolvedValue({ ...DEFAULTS, eventRetentionDays: -1, doraRetentionDays: 1000 });
    await handler()({ query: {} }, {});
    expect(payload().retention).toEqual({
      eventRetentionDays: -1, doraRetentionDays: 1000, eventMaxRangeDays: 730, doraMaxRangeDays: 730,
    });
  });
});
