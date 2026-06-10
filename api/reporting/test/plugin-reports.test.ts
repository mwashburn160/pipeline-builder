// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for plugin report routes.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetPluginSummary = jest.fn();
const mockGetPluginDistribution = jest.fn();
const mockGetPluginVersions = jest.fn();
const mockGetBuildSuccessRate = jest.fn();
const mockGetBuildDuration = jest.fn();
const mockGetBuildFailures = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendError: jest.fn(),
  sendBadRequest: jest.fn(),
  getServiceAuthHeader: jest.fn(() => ({})),
  parseDateRange: jest.fn(() => ({ from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z' })),
  REPORT_INTERVALS: ['day', 'week', 'month'] as const,
  isSystemAdmin: jest.fn((req: any) => req?.user?.isSuperAdmin === true),
  parseQueryIntClamped: jest.fn((val: any, def: number, max: number) =>
    Math.min(Math.max(1, parseInt(String(val ?? def), 10) || def), max)),
  validateBulkArray: jest.fn((value: any, _name: string, max?: number) =>
    Array.isArray(value) && value.length > 0 && (!max || value.length <= max)
      ? { value }
      : { error: 'invalid' }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: {
    getPluginSummary: mockGetPluginSummary,
    getPluginDistribution: mockGetPluginDistribution,
    getPluginVersions: mockGetPluginVersions,
    getBuildSuccessRate: mockGetBuildSuccessRate,
    getBuildDuration: mockGetBuildDuration,
    getBuildFailures: mockGetBuildFailures,
  },
}));

const { sendSuccess, sendBadRequest } = await import('@pipeline-builder/api-core');
const { createPluginReportRoutes } = await import('../src/routes/plugin-reports.js');

describe('Plugin Report Routes', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createPluginReportRoutes();
  });

  function getHandler(path: string) {
    return router.stack.find((l: any) => l.route?.path === path)?.route?.stack[0]?.handle;
  }

  describe('GET /summary', () => {
    it('should return plugin summary', async () => {
      mockGetPluginSummary.mockResolvedValue({ total: 10, active: 8 });
      const handler = getHandler('/summary');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      expect(mockGetPluginSummary).toHaveBeenCalledWith('acme');
      expect(sendSuccess).toHaveBeenCalled();
    });
  });

  describe('GET /distribution', () => {
    it('should return type/compute distribution', async () => {
      mockGetPluginDistribution.mockResolvedValue([{ plugin_type: 'CodeBuildStep', count: 5 }]);
      const handler = getHandler('/distribution');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      expect(mockGetPluginDistribution).toHaveBeenCalledWith('acme');
    });
  });

  describe('GET /versions', () => {
    it('should return version counts', async () => {
      mockGetPluginVersions.mockResolvedValue([{ name: 'nodejs-build', version_count: 3 }]);
      const handler = getHandler('/versions');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      expect(mockGetPluginVersions).toHaveBeenCalledWith('acme');
    });
  });

  describe('GET /build-success-rate', () => {
    it('should return build success rate', async () => {
      mockGetBuildSuccessRate.mockResolvedValue([{ period: '2026-03', succeeded: 8 }]);
      const handler = getHandler('/build-success-rate');
      const req = { query: { interval: 'week' } };
      const res = {};

      await handler(req, res);

      expect(mockGetBuildSuccessRate).toHaveBeenCalled();
    });

    it('should reject invalid interval', async () => {
      const handler = getHandler('/build-success-rate');
      const req = { query: { interval: 'hour' } };
      const res = {};

      await handler(req, res);

      expect(sendBadRequest).toHaveBeenCalled();
    });
  });

  describe('GET /build-duration', () => {
    it('should return build duration per plugin', async () => {
      mockGetBuildDuration.mockResolvedValue([{ plugin_name: 'nodejs', avg_ms: 45000 }]);
      const handler = getHandler('/build-duration');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      expect(mockGetBuildDuration).toHaveBeenCalled();
    });
  });

  describe('GET /build-failures', () => {
    it('should return build failures with limit', async () => {
      mockGetBuildFailures.mockResolvedValue([]);
      const handler = getHandler('/build-failures');
      // /build-failures is system-admin-only; mark the request principal so the
      // isSystemAdmin gate passes.
      const req = { query: { limit: '5' }, user: { isSuperAdmin: true } };
      const res = {};

      await handler(req, res);

      expect(mockGetBuildFailures).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), 5);
    });
  });
});
