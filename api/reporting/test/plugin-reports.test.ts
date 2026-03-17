/**
 * Tests for plugin report routes.
 */

const mockGetPluginSummary = jest.fn();
const mockGetPluginDistribution = jest.fn();
const mockGetPluginVersions = jest.fn();
const mockGetBuildSuccessRate = jest.fn();
const mockGetBuildDuration = jest.fn();
const mockGetBuildFailures = jest.fn();

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR' },
  createLogger: () => ({ info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@mwashburn160/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.mock('@mwashburn160/pipeline-data', () => ({
  reportingService: {
    getPluginSummary: mockGetPluginSummary,
    getPluginDistribution: mockGetPluginDistribution,
    getPluginVersions: mockGetPluginVersions,
    getBuildSuccessRate: mockGetBuildSuccessRate,
    getBuildDuration: mockGetBuildDuration,
    getBuildFailures: mockGetBuildFailures,
  },
}));

import { sendSuccess, sendBadRequest } from '@mwashburn160/api-core';
import { createPluginReportRoutes } from '../src/routes/plugin-reports';

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
      const req = { query: { limit: '5' } };
      const res = {};

      await handler(req, res);

      expect(mockGetBuildFailures).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), 5);
    });
  });
});
