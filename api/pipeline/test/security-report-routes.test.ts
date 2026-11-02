// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/security-report-routes — the upload gate (a
 * `reporting:ingest`-scoped key OR a member with `pipelines:write`), the
 * normalize-on-the-way-in upload, and the latest-per-slot read.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { getRouteGates } from '@pipeline-builder/api-core';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRecordAudit = jest.fn<AnyFn>();
const mockFindById = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: req.user?.sub ?? 'user-1' });
  },
  createAuthenticatedWithOrgRoute: () => [],
}));

const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // The REAL permission check — the pipeline mock defaults it to false.
  userHasPermission: actualApiCore.userHasPermission,
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  getParam: (params: Record<string, string>, key: string) => params[key],
}));

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

const { createSecurityReportRoutes, requireReportUploader } = await import('../src/routes/security-report-routes.js');
const { memorySecurityReportStore, setSecurityReportStoreForTests } = await import('../src/services/security-report-store.js');

const res = () => {
  const r: any = { status: jest.fn<AnyFn>(), json: jest.fn<AnyFn>(), setHeader: jest.fn<AnyFn>(), headersSent: false };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
};

const grype = { matches: [{ vulnerability: { id: 'CVE-1', severity: 'Critical', fix: { state: 'fixed', versions: ['2'] } }, artifact: { name: 'openssl', version: '1' } }] };

describe('requireReportUploader', () => {
  const run = (user: unknown) => {
    const next = jest.fn<AnyFn>();
    const r = res();
    requireReportUploader({ user, method: 'POST', url: '/pipelines/p1/security-reports', originalUrl: '/pipelines/p1/security-reports' } as never, r, next);
    return { next, r };
  };

  it('admits the org\'s reporting:ingest-scoped key (a scoped token carries no permissions)', () => {
    expect(run({ sub: 'sa-1', organizationId: 'acme', scope: 'reporting:ingest', permissions: [] }).next).toHaveBeenCalled();
  });

  it('admits a member holding pipelines:write', () => {
    expect(run({ sub: 'u-1', organizationId: 'acme', permissions: ['pipelines:write'] }).next).toHaveBeenCalled();
  });

  it('refuses a member without pipelines:write, and a key with another scope', () => {
    for (const user of [
      { sub: 'u-2', organizationId: 'acme', permissions: ['pipelines:read'] },
      { sub: 'sa-2', organizationId: 'acme', scope: 'registry:push', permissions: [] },
    ]) {
      const { next, r } = run(user);
      expect(next).not.toHaveBeenCalled();
      expect(r.status).toHaveBeenCalledWith(403);
      expect(r.json.mock.calls[0][0]).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    }
  });

  it('answers 401 when unauthenticated', () => {
    const { next, r } = run(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
  });

  it('declares both credentials on the route table', () => {
    expect(getRouteGates(requireReportUploader)).toEqual([
      { kind: 'permission', mode: 'any', permissions: ['pipelines:write'] },
      { kind: 'scope', scope: 'reporting:ingest' },
    ]);
  });
});

describe('security report routes', () => {
  let store: ReturnType<typeof memorySecurityReportStore>;
  const router = createSecurityReportRoutes() as any;
  const handler = (method: string) => {
    const layer = router.stack.find((l: any) => l.route?.path === '/:id/security-reports' && l.route.methods[method]);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  };
  const scoped = { sub: 'sa-1', organizationId: 'acme', scope: 'reporting:ingest', permissions: [] };

  beforeEach(() => {
    jest.clearAllMocks();
    store = memorySecurityReportStore();
    setSecurityReportStoreForTests(store);
    mockFindById.mockResolvedValue({ id: 'p1', orgId: 'acme' });
  });
  afterAll(() => setSecurityReportStoreForTests(null));

  it('runs the upload gate in the POST chain (not a plain requirePermission)', () => {
    const layer = router.stack.find((l: any) => l.route?.path === '/:id/security-reports' && l.route.methods.post);
    expect(layer.route.stack.map((l: any) => l.handle)).toContain(requireReportUploader);
  });

  it('normalizes and stores the report under the key\'s org, audited', async () => {
    const r = res();
    await handler('post')({ params: { id: 'p1' }, user: scoped, body: { tool: 'Grype', format: 'grype-json', stage: 'Build', executionId: 'ex-1', report: grype } }, r);
    expect(r.status).toHaveBeenCalledWith(201);
    expect(mockFindById).toHaveBeenCalledWith('p1', 'acme');
    expect(store.rows).toEqual([expect.objectContaining({
      orgId: 'acme', pipelineId: 'p1', tool: 'grype', stage: 'Build', executionId: 'ex-1', submittedBy: expect.stringContaining('sa-1'),
    })]);
    expect(store.rows[0]!.counts).toEqual(expect.objectContaining({ critical: 1, criticalFixable: 1 }));
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pipeline.security_report.upload',
      orgId: 'acme',
      targetId: 'p1',
      details: expect.objectContaining({ tool: 'grype', stage: 'Build', executionId: 'ex-1' }),
    }));
  });

  it('refuses a report that is not the declared format (an unreadable scan is never clean)', async () => {
    const r = res();
    await handler('post')({ params: { id: 'p1' }, user: scoped, body: { tool: 'grype', format: 'grype-json', report: { Results: [] } } }, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(store.rows).toHaveLength(0);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('400s an invalid body and 404s a pipeline outside the org', async () => {
    const bad = res();
    await handler('post')({ params: { id: 'p1' }, user: scoped, body: { tool: 'no spaces allowed', format: 'grype-json', report: grype } }, bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    mockFindById.mockResolvedValueOnce(null);
    const missing = res();
    await handler('post')({ params: { id: 'p9' }, user: scoped, body: { tool: 'grype', format: 'grype-json', report: grype } }, missing);
    expect(missing.status).toHaveBeenCalledWith(404);
    expect(store.rows).toHaveLength(0);
  });

  it('reads the latest report per (tool, stage) with the summed counts', async () => {
    await handler('post')({ params: { id: 'p1' }, user: scoped, body: { tool: 'grype', format: 'grype-json', stage: 'Build', report: grype } }, res());
    await handler('post')({ params: { id: 'p1' }, user: scoped, body: { tool: 'grype', format: 'grype-json', stage: 'Build', report: grype } }, res());
    await handler('post')({ params: { id: 'p1' }, user: scoped, body: { tool: 'trivy', format: 'trivy-json', report: { Results: [] } } }, res());
    const r = res();
    await handler('get')({ params: { id: 'p1' }, user: { sub: 'u-1', permissions: ['pipelines:read'] } }, r);
    expect(r.status).toHaveBeenCalledWith(200);
    const data = r.json.mock.calls[0][0].data;
    expect(data.pipelineId).toBe('p1');
    expect(data.reports).toHaveLength(2);
    expect(data.counts).toEqual(expect.objectContaining({ critical: 1 }));
    expect(typeof data.latestAt).toBe('string');
  });

  it('404s the read for a pipeline outside the org', async () => {
    mockFindById.mockResolvedValueOnce(null);
    const r = res();
    await handler('get')({ params: { id: 'p9' } }, r);
    expect(r.status).toHaveBeenCalledWith(404);
  });
});
