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

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindById = jest.fn();
const mockExecute = jest.fn();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { findById: mockFindById, find: jest.fn(), findPaginated: jest.fn() },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  requirePublicAccess: () => true,
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any) => {
    res.status(statusCode).json({ success: true, statusCode, data });
  }),
  sendPaginatedNested: jest.fn(),
  sendEntityNotFound: jest.fn(),
  normalizeArrayFields: (x: any) => x,
  validateQuery: () => ({ ok: true, value: {} }),
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  PluginFilterSchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId ?? 'org-1', userId: 'u-1' });
  },
  incrementQuotaFromCtx: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'private, max-age=30', CACHE_CONTROL_DETAIL: 'private, max-age=60' },
  // The route was migrated from direct `db.execute(...)` to
  // `withTenantTx(tx => tx.execute(...))`. The mock hands back a tx whose
  // execute funnels through the same mockExecute spy so per-test
  // mockExecute.mockResolvedValue(...) calls still drive responses.
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    execute: (...args: unknown[]) => mockExecute(...args),
  }),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'private, max-age=30', CACHE_CONTROL_DETAIL: 'private, max-age=60' },
  // The route was migrated from direct `db.execute(...)` to
  // `withTenantTx(tx => tx.execute(...))`. The mock hands back a tx whose
  // execute funnels through the same mockExecute spy so per-test
  // mockExecute.mockResolvedValue(...) calls still drive responses.
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    execute: (...args: unknown[]) => mockExecute(...args),
  }),
}));;

const { createReadPluginRoutes } = await import('../src/routes/read-plugins.js');

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

/** Flatten every string primitive reachable from a drizzle `SQL` object
 *  (StringChunk `.value` fragments + inlined param values) so a test can
 *  assert on both the emitted SQL text and its bound parameters. */
function collectStrings(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const c = stack.pop();
    if (typeof c === 'string') { out.push(c); continue; }
    if (c == null || typeof c !== 'object' || seen.has(c)) continue;
    seen.add(c);
    for (const v of Array.isArray(c) ? c : Object.values(c)) stack.push(v);
  }
  return out;
}

describe('GET /plugins/plugin-usage', () => {
  const handler = getHandler('/plugin-usage');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes the aggregation to the caller org (explicit org_id predicate + bound param)', async () => {
    // Cross-org leak regression: the query must NOT rely on Postgres RLS alone
    // (documented as running in owner-BYPASS mode). It must carry an explicit
    // `p.org_id = <callerOrg>` predicate so only the caller's pipelines are
    // counted.
    mockExecute.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await handler({ __orgId: 'org-a', query: {} } as any, res);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const strings = collectStrings(mockExecute.mock.calls[0][0]);
    // SQL text carries an explicit org predicate...
    expect(strings.some((s) => s.includes('org_id'))).toBe(true);
    // ...bound to the caller's (already-lowercased) org, not some other tenant.
    expect(strings).toContain('org-a');
    expect(strings).not.toContain('org-b');
  });

  it('binds a DIFFERENT caller org into the predicate (no fixed/leaky org)', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const res = mockRes();
    await handler({ __orgId: 'org-zzz', query: {} } as any, res);
    const strings = collectStrings(mockExecute.mock.calls[0][0]);
    expect(strings).toContain('org-zzz');
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
