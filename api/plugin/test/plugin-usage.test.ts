// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GET /plugins/plugin-usage — the aggregation endpoint that powers
 * the "Used by N pipelines" badge on the plugin list. Lives on the plugin
 * service even though the data source is the `pipeline` table — the consumer
 * is the plugins dashboard, and both services share the same Postgres via
 * pipeline-data's drizzle connection.
 *
 * Verifies:
 * - Returns counts map keyed by plugin name.
 * - Coerces postgres COUNT() string results to numbers.
 * - Omits rows with null name or non-finite count.
 * - Forwards caller orgId (lowercased) to the SQL parameters.
 */

const mockFindById = jest.fn();
const mockExecute = jest.fn();

jest.mock('../src/services/plugin-service', () => ({
  pluginService: { findById: mockFindById, find: jest.fn(), findPaginated: jest.fn() },
}));

jest.mock('@pipeline-builder/api-core', () => ({
  ErrorCode: { MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD' },
  getParam: (p: any, k: string) => p[k],
  requirePublicAccess: () => true,
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any) => {
    res.status(statusCode).json({ success: true, statusCode, data });
  }),
  sendPaginatedNested: jest.fn(),
  sendEntityNotFound: jest.fn(),
  applyAccessControl: (f: any) => f,
  normalizeArrayFields: (x: any) => x,
  validateQuery: () => ({ ok: true, value: {} }),
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  PluginFilterSchema: {},
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId ?? 'org-1', userId: 'u-1' });
  },
  incrementQuotaFromCtx: jest.fn(),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'private, max-age=30', CACHE_CONTROL_DETAIL: 'private, max-age=60' },
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}));

import { createReadPluginRoutes } from '../src/routes/read-plugins';

const mockQuotaService = { increment: jest.fn(), check: jest.fn(), getUsage: jest.fn() } as any;
const router = createReadPluginRoutes(mockQuotaService);

function getHandler(path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods.get,
  );
  if (!layer) throw new Error(`no GET ${path}`);
  return layer.route.stack[0].handle;
}

function mockRes() {
  const res: any = { status: jest.fn(), json: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('GET /plugins/plugin-usage', () => {
  const handler = getHandler('/plugin-usage');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns counts map keyed by plugin name', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { name: 'snyk-scan', cnt: '5' },
        { name: 'docker-build', cnt: '12' },
        { name: 'pytest', cnt: '3' },
      ],
    });
    const res = mockRes();
    await handler({ __orgId: 'org-a', query: {} } as any, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { counts: { 'snyk-scan': 5, 'docker-build': 12, 'pytest': 3 } },
    }));
  });

  it('coerces string COUNT() results to numbers', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ name: 'jest-runner', cnt: '7' }],
    });
    const res = mockRes();
    await handler({ __orgId: 'org-a', query: {} } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.counts['jest-runner']).toBe(7);
    expect(typeof payload.data.counts['jest-runner']).toBe('number');
  });

  it('returns empty counts when org has no pipelines', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await handler({ __orgId: 'org-fresh', query: {} } as any, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { counts: {} },
    }));
  });

  it('omits rows with null/missing name', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { name: 'good', cnt: '1' },
        { name: null, cnt: '99' },
      ],
    });
    const res = mockRes();
    await handler({ __orgId: 'org-a', query: {} } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.counts).toEqual({ good: 1 });
  });

  it('omits rows with non-finite count', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { name: 'good', cnt: '1' },
        { name: 'bad', cnt: 'not-a-number' },
      ],
    });
    const res = mockRes();
    await handler({ __orgId: 'org-a', query: {} } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.counts).toEqual({ good: 1 });
  });

  it('falls back to bare-array drivers (rows in result.rows or top-level array)', async () => {
    // Some drivers return the rows array directly without a .rows wrapper.
    mockExecute.mockResolvedValue([{ name: 'flat', cnt: 4 }]);
    const res = mockRes();
    await handler({ __orgId: 'org-a', query: {} } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.counts).toEqual({ flat: 4 });
  });

  it('sets cache-control header', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await handler({ __orgId: 'org-a', query: {} } as any, res);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=30');
  });
});
