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
const mockResolveOrgRollup = jest.fn();

// The single reports:rollup predicate — shared by the api-core `userHasPermission`
// mock and the helpers `rollupIds` mock so the two can't diverge in-test.
const permCheck = (req: any, perm: string) =>
  req?.user?.isSuperAdmin === true || (req?.user?.permissions ?? []).includes(perm);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendError: jest.fn(),
  sendBadRequest: jest.fn(),
  getServiceAuthHeader: jest.fn(() => ({})),
  parseDateRange: jest.fn(() => ({ from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z' })),
  REPORT_INTERVALS: ['day', 'week', 'month'] as const,
  parseReportInterval: jest.fn((query: any) => {
    const interval = String(query?.interval ?? 'week');
    return ['day', 'week', 'month'].includes(interval)
      ? interval
      : { error: 'interval must be one of: day, week, month' };
  }),
  isSystemAdmin: jest.fn((req: any) => req?.user?.isSuperAdmin === true),
  // Build reports gate their ?includeDescendants rollup on reports:rollup (the
  // plugin INVENTORY reports stay single-org), so the route needs this helper.
  userHasPermission: jest.fn(permCheck),
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

// The route imports ../helpers.js, which imports `Config` from pipeline-core to
// resolve the platform host/port for the shared org-descendants client. Stub
// pipeline-core so this api-core-mocking suite doesn't pull in its full config
// graph (aws-cdk-lib, etc.).
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: {
    get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }),
  },
}));

// `rollupIds` now lives in helpers.js (shared by both report routers). Since it
// calls `resolveOrgRollup` intra-module, overriding only the resolveOrgRollup
// export can't intercept it, so override `rollupIds` too — reproducing its gate
// (reports:rollup + ?includeDescendants) against the mocked resolveOrgRollup so
// the mockResolveOrgRollup assertions still hold. Keep the rest of helpers.js
// real (MAX_* caps, scrubErrorMessage).
jest.unstable_mockModule('../src/helpers.js', () => {
  const actual = jest.requireActual('../src/helpers.js') as Record<string, unknown>;
  return {
    ...actual,
    resolveOrgRollup: (...a: unknown[]) => mockResolveOrgRollup(...a),
    rollupIds: (req: any, orgId: string) =>
      req?.query?.includeDescendants === 'true' && permCheck(req, 'reports:rollup')
        ? mockResolveOrgRollup(orgId)
        : Promise.resolve(undefined),
  };
});

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
    it('should return build success rate (no rollup by default)', async () => {
      mockGetBuildSuccessRate.mockResolvedValue([{ period: '2026-03', succeeded: 8 }]);
      const handler = getHandler('/build-success-rate');
      const req = { query: { interval: 'week' } };
      const res = {};

      await handler(req, res);

      // 5th arg is the optional org→team rollup id-list (undefined without ?includeDescendants).
      expect(mockResolveOrgRollup).not.toHaveBeenCalled();
      expect(mockGetBuildSuccessRate).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String), undefined);
    });

    it('should reject invalid interval', async () => {
      const handler = getHandler('/build-success-rate');
      const req = { query: { interval: 'hour' } };
      const res = {};

      await handler(req, res);

      expect(sendBadRequest).toHaveBeenCalled();
    });

    it('rolls up over the subtree for a reports:rollup holder', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockGetBuildSuccessRate.mockResolvedValue([]);
      const handler = getHandler('/build-success-rate');
      await handler({ query: { interval: 'week', includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});

      expect(mockResolveOrgRollup).toHaveBeenCalledWith('acme');
      expect(mockGetBuildSuccessRate).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String), ['acme', 'team-child']);
    });

    it('ignores ?includeDescendants without reports:rollup (single-org)', async () => {
      mockGetBuildSuccessRate.mockResolvedValue([]);
      const handler = getHandler('/build-success-rate');
      await handler({ query: { interval: 'week', includeDescendants: 'true' }, user: { permissions: ['reports:read'] } }, {});

      expect(mockResolveOrgRollup).not.toHaveBeenCalled();
      expect(mockGetBuildSuccessRate).toHaveBeenCalledWith('acme', 'week', expect.any(String), expect.any(String), undefined);
    });
  });

  describe('GET /build-duration', () => {
    it('should return build duration per plugin (no rollup by default)', async () => {
      mockGetBuildDuration.mockResolvedValue([{ plugin_name: 'nodejs', avg_ms: 45000 }]);
      const handler = getHandler('/build-duration');
      const req = { query: {} };
      const res = {};

      await handler(req, res);

      expect(mockGetBuildDuration).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), undefined);
    });

    it('rolls up over the subtree for a reports:rollup holder', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockGetBuildDuration.mockResolvedValue([]);
      const handler = getHandler('/build-duration');
      await handler({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});

      expect(mockGetBuildDuration).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), ['acme', 'team-child']);
    });
  });

  describe('GET /build-failures', () => {
    it('should return build failures with limit (no rollup by default)', async () => {
      mockGetBuildFailures.mockResolvedValue([]);
      const handler = getHandler('/build-failures');
      // /build-failures is system-admin-only; mark the request principal so the
      // isSystemAdmin gate passes.
      const req = { query: { limit: '5' }, user: { isSuperAdmin: true } };
      const res = {};

      await handler(req, res);

      expect(mockGetBuildFailures).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), 5, undefined);
    });

    it('rolls up over the subtree with ?includeDescendants (superadmin implicit-all)', async () => {
      mockResolveOrgRollup.mockResolvedValue(['acme', 'team-child']);
      mockGetBuildFailures.mockResolvedValue([]);
      const handler = getHandler('/build-failures');
      await handler({ query: { limit: '5', includeDescendants: 'true' }, user: { isSuperAdmin: true } }, {});

      expect(mockResolveOrgRollup).toHaveBeenCalledWith('acme');
      expect(mockGetBuildFailures).toHaveBeenCalledWith('acme', expect.any(String), expect.any(String), 5, ['acme', 'team-child']);
    });
  });

  // Plugin INVENTORY reports are intentionally single-org (no rollup thread) —
  // they take only orgId and never resolve a subtree, even with the flag set.
  describe('plugin inventory stays single-org (no rollup)', () => {
    it('summary/distribution/versions never resolve a rollup', async () => {
      mockGetPluginSummary.mockResolvedValue({ total: 0 });
      mockGetPluginDistribution.mockResolvedValue([]);
      mockGetPluginVersions.mockResolvedValue([]);
      const req = { query: { includeDescendants: 'true' }, user: { isSuperAdmin: true } };

      await getHandler('/summary')(req, {});
      await getHandler('/distribution')(req, {});
      await getHandler('/versions')(req, {});

      expect(mockResolveOrgRollup).not.toHaveBeenCalled();
      expect(mockGetPluginSummary).toHaveBeenCalledWith('acme');
      expect(mockGetPluginDistribution).toHaveBeenCalledWith('acme');
      expect(mockGetPluginVersions).toHaveBeenCalledWith('acme');
    });
  });
});
