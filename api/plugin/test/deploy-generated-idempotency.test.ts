// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Idempotency-Key guard on POST /plugins/deploy-generated.
 *
 * The auto-plugin-creation path (generate-pipeline.ts) sends
 * `Idempotency-Key: <requestId>:<name>`; an SSE retry must NOT enqueue a
 * duplicate buildkit build or double the `plugins` quota. The route claims the
 * key via the Redis IdempotencyStore (SET…NX) BEFORE reserving quota or
 * enqueuing, and releases it on any pre-enqueue failure so a legit retry isn't
 * wrongly suppressed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- Mocks (before imports) ---------------------------------------------------

const mockReserveQuota = jest.fn<(...args: any[]) => any>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'plugins', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } }));
const mockDecrementQuota = jest.fn();
const mockValidatePlugin = jest.fn<(...args: any[]) => any>(() =>
  Promise.resolve({ blocked: false, violations: [], warnings: [] }));

const mockIdemReserve = jest.fn<(...args: any[]) => Promise<boolean>>().mockResolvedValue(true);
const mockIdemDelete = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
// Reads back the reservation body on a duplicate to recover the ORIGINAL
// request's id (the build streams under that id, not the retry's).
const mockIdemGet = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null);

const mockEnqueueBuild = jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined);
const mockGetOrgTier = jest.fn<(...args: any[]) => any>().mockResolvedValue('developer');
const mockCreateBuildJobData = jest.fn<(...args: any[]) => any>((p) => p);
const mockEmitPluginAudit = jest.fn();
// the route binds the build-log stream's owner at enqueue so a cross-org
// ticket mint for this requestId is refused.
const mockBindStreamOwner = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
const mockRmSync = jest.fn();

jest.unstable_mockModule('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  rmSync: mockRmSync,
}));

// Object storage (MinIO/S3) for the staged build context.
const mockPutPluginArtifact = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
const mockDeletePluginArtifact = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/services/plugin-artifact-storage.js', () => ({
  putPluginArtifact: mockPutPluginArtifact,
  deletePluginArtifact: mockDeletePluginArtifact,
  pluginArtifactKey: (orgId: string, requestId: string) => `${orgId}/${requestId}.zip`,
}));

// A REAL quota client whose quota service is unreachable (nothing listens on
// port 1) — used to drive the route with what an outage actually looks like:
// the safe HTTP client returns null, so reserve RESOLVES `unavailable` rather
// than throwing. Loaded by file path, not through the mocked api-core entry.
const realQuota = await import('@pipeline-builder/api-core/lib/services/quota.js') as {
  createQuotaService: (cfg: { host: string; port: number; timeout: number }) => any;
  reserveQuota: (...args: any[]) => Promise<any>;
};
const unreachableQuotaService = realQuota.createQuotaService({ host: '127.0.0.1', port: 1, timeout: 500 });

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPluginAudit,
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  getServiceAuthHeader: () => 'Bearer service-token',
  resolveVisibility: (_req: any, val: string) => val || 'private',
  createComplianceClient: () => ({ validatePlugin: mockValidatePlugin }),
  validateBody: jest.fn(() => ({
    ok: true,
    value: {
      name: 'my-plugin',
      description: 'd',
      version: '1.0.0',
      pluginType: 'CodeBuildStep',
      computeType: 'MEDIUM',
      keywords: [],
      primaryOutputDirectory: null,
      installCommands: [],
      commands: ['echo hi'],
      env: {},
      buildArgs: {},
      dockerfile: 'FROM node',
      visibility: 'private',
    },
  })),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string) => res.status(status).json({ message: msg })),
  sendQuotaReserveDenied: jest.fn((res: any, _t: string, r: any) => (r.unavailable
    ? res.status(503).json({ message: 'quota unavailable' })
    : res.status(429).json({ message: 'quota exceeded' }))),
  sendSuccess: jest.fn((res: any, status: number, data?: any) => res.status(status).json({ success: true, data })),
  PluginDeployGeneratedSchema: {},
}));

// The REAL reservation helper (its api-core calls hit this file's api-core mock).
let realWithQuotaReservation: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withQuotaReservation: (...a: any[]) => realWithQuotaReservation(...a),
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = req.context;
    await handler({ req, res, ctx, orgId: ctx.identity.orgId?.toLowerCase() || '', userId: ctx.identity.userId || '' });
  },
  getIdempotencyStore: () => ({ reserve: mockIdemReserve, delete: mockIdemDelete, get: mockIdemGet, set: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: (section: string) => (section === 'registry' ? { host: 'r', port: 5000, network: '', http: true } : {}) },
  CoreConstants: { IDEMPOTENCY_TTL_MS: 300000 },
}));

jest.unstable_mockModule('../src/helpers/docker-build.js', () => ({ BUILD_TEMP_ROOT: '/tmp/builds' }));
jest.unstable_mockModule('../src/helpers/plugin-helpers.js', () => ({ createBuildJobData: mockCreateBuildJobData }));
jest.unstable_mockModule('../src/helpers/plugin-spec.js', () => ({ validateBuildArgs: jest.fn() }));
jest.unstable_mockModule('../src/queue/connections.js', () => ({ enqueueBuild: mockEnqueueBuild, getOrgTier: mockGetOrgTier }));
// Overwrite gate pre-check (throws a typed 403/409 for a non-writable / tombstoned
// (name, version)); default: deployable.
const mockAssertDeployable = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService: { assertDeployable: mockAssertDeployable } }));

({ withQuotaReservation: realWithQuotaReservation } = await import('@pipeline-builder/api-server/lib/api/quota-reservation.js'));
const { createDeployGeneratedPluginRoutes } = await import('../src/routes/deploy-generated-plugin.js');

// -- Helpers ------------------------------------------------------------------

const mockQuotaService = {} as any;
const mockSseManager = { bindStreamOwner: mockBindStreamOwner } as any;
const router = createDeployGeneratedPluginRoutes(mockQuotaService, mockSseManager);

function getHandler() {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === '/deploy-generated' && l.route?.methods.post,
  );
  if (!layer) throw new Error('deploy-generated handler not registered');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(idempotencyKey?: string): any {
  return {
    headers: { authorization: 'Bearer user-tok', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    user: { sub: 'user-9' },
    context: { identity: { orgId: 'ORG-1', userId: 'user-9' }, log: jest.fn(), requestId: 'req-1' },
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// -- Tests --------------------------------------------------------------------

describe('POST /deploy-generated — Idempotency-Key guard', () => {
  const handler = getHandler();

  beforeEach(() => {
    jest.clearAllMocks();
    mockIdemReserve.mockResolvedValue(true);
    mockIdemGet.mockResolvedValue(null);
    mockEnqueueBuild.mockResolvedValue(undefined);
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'plugins', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } });
    mockValidatePlugin.mockResolvedValue({ blocked: false, violations: [], warnings: [] });
    mockPutPluginArtifact.mockResolvedValue(undefined);
  });

  it('claims the key BEFORE reserving quota and queues the build on first request', async () => {
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    // Key claimed under the org-namespaced deploy-generated prefix, with THIS
    // request's id persisted in the reservation body (so a later duplicate can
    // return the original id and tail the real build stream).
    expect(mockIdemReserve).toHaveBeenCalledWith(
      'plugin:deploy-generated:org-1:req-1:my-plugin',
      expect.objectContaining({ pending: true, body: { requestId: 'req-1' } }),
      expect.any(Number),
    );
    // Quota reserved + build enqueued exactly once; reservation kept (not released).
    expect(mockReserveQuota).toHaveBeenCalledTimes(1);
    expect(mockEnqueueBuild).toHaveBeenCalledTimes(1);
    expect(mockIdemDelete).not.toHaveBeenCalled();
    // stream owner bound (requestId, orgId) before the build was queued.
    expect(mockBindStreamOwner).toHaveBeenCalledWith('req-1', 'org-1');
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('defers the image facts in the compliance preflight (evaluated post-build), like the upload', async () => {
    await handler(mockReq(), mockRes());
    const [orgId, attributes, , , name, action, deferred] = mockValidatePlugin.mock.calls[0] as any[];
    expect([orgId, name, action]).toEqual(['org-1', 'my-plugin', 'deploy-generated']);
    expect(attributes).toMatchObject({ buildType: 'build_image', tags: expect.any(Array) });
    expect(attributes).not.toHaveProperty('signed');
    expect(deferred).toEqual(expect.arrayContaining(['signed', 'scanned']));
  });

  it('suppresses a duplicate (key already claimed): no quota reserve, no enqueue', async () => {
    mockIdemReserve.mockResolvedValueOnce(false);
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
    // Suppressed before any stream is produced → no owner binding either.
    expect(mockBindStreamOwner).not.toHaveBeenCalled();
    // Returns a benign idempotent 202 so the caller isn't errored.
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotent: true }),
    }));
  });

  it('duplicate returns the ORIGINAL request id (from the reservation body), not the retry\'s', async () => {
    // The winning request queued the build under `original-req-0` and stored
    // that id in the reservation body. This retry carries its own `req-1`, but
    // the build streams under the original id — so the route must echo the
    // stored original or the client tails an empty stream.
    mockIdemReserve.mockResolvedValueOnce(false);
    mockIdemGet.mockResolvedValueOnce({
      statusCode: 202, body: { requestId: 'original-req-0' }, pending: true, expiresAt: Date.now() + 1000,
    });
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(mockIdemGet).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotent: true, requestId: 'original-req-0' }),
    }));
  });

  it('duplicate falls back to this request id when the reservation record can\'t be read', async () => {
    // Redis hiccup on the read-back — degrade to the caller's own id rather than
    // erroring the benign duplicate.
    mockIdemReserve.mockResolvedValueOnce(false);
    mockIdemGet.mockRejectedValueOnce(new Error('redis down'));
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotent: true, requestId: 'req-1' }),
    }));
  });

  it('releases the key when quota is exceeded (so a legit retry can proceed)', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota: { type: 'plugins', limit: 1, used: 1, remaining: 0, resetAt: '2026-08-01T00:00:00Z' } });
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('releases the key when compliance blocks the deploy', async () => {
    mockValidatePlugin.mockResolvedValueOnce({ blocked: true, violations: [{ rule: 'x' }], warnings: [] });
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('quota service down: releases the key and answers 503 (reserve resolves `unavailable`, never throws)', async () => {
    // Drive the route through the REAL quota client against an unreachable
    // quota service — the realistic outage shape.
    mockReserveQuota.mockImplementationOnce((_qs: any, ...rest: any[]) => realQuota.reserveQuota(unreachableQuotaService, ...rest));
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
    expect(mockDecrementQuota).not.toHaveBeenCalled(); // nothing was reserved
  });

  it('releases the key when compliance is unreachable (503 fail-closed)', async () => {
    mockValidatePlugin.mockRejectedValueOnce(new Error('compliance unreachable'));
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    // Slot rolled back and nothing queued.
    expect(mockDecrementQuota).toHaveBeenCalled();
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('releases the key when enqueue throws (build never queued → retry allowed)', async () => {
    mockEnqueueBuild.mockRejectedValueOnce(new Error('queue down'));
    const res = mockRes();
    await expect(handler(mockReq('req-1:my-plugin'), res)).rejects.toThrow('queue down');

    // Rollback try releases the idem key AND refunds the reserved slot, and the
    // staged context + local scratch dir don't orphan.
    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    expect(mockDecrementQuota).toHaveBeenCalled();
    expect(mockDeletePluginArtifact).toHaveBeenCalledWith('org-1/req-1.zip');
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/builds\//), { recursive: true, force: true });
  });

  // The build worker runs on every replica; a context written only to THIS
  // pod's scratch dir failed every build BullMQ handed to another replica.
  it('stages the build context (a ZIP holding the Dockerfile) in object storage and hands the worker its key', async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(mockPutPluginArtifact).toHaveBeenCalledTimes(1);
    const [key, body] = mockPutPluginArtifact.mock.calls[0] as [string, Buffer];
    expect(key).toBe('org-1/req-1.zip');
    // A real ZIP the worker's extractor can re-materialize.
    const { default: AdmZip } = await import('adm-zip');
    const entries = new AdmZip(body).getEntries().map((e) => [e.entryName, e.getData().toString('utf-8')]);
    expect(entries).toEqual([['Dockerfile', 'FROM node']]);

    // Staged BEFORE the build is queued, and the job carries the key.
    expect(mockPutPluginArtifact.mock.invocationCallOrder[0]).toBeLessThan(mockEnqueueBuild.mock.invocationCallOrder[0]);
    expect(mockCreateBuildJobData).toHaveBeenCalledWith(expect.objectContaining({
      buildRequest: expect.objectContaining({ s3Key: 'org-1/req-1.zip', dockerfile: 'Dockerfile' }),
    }));
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('never queues a build whose context could not be staged: 503, slot refunded, key released', async () => {
    mockPutPluginArtifact.mockRejectedValueOnce(new Error('minio down'));
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      mockQuotaService, 'org-1', 'plugins', 'Bearer service-token', expect.any(Function), 1, '2026-08-01T00:00:00Z',
    );
    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
  });

  it('is a no-op guard when no Idempotency-Key header is present', async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(mockIdemReserve).not.toHaveBeenCalled();
    expect(mockIdemDelete).not.toHaveBeenCalled();
    // Normal flow still reserves + enqueues.
    expect(mockReserveQuota).toHaveBeenCalledTimes(1);
    expect(mockEnqueueBuild).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('refuses a deploy that would overwrite a non-writable / deleted version BEFORE the idem claim, quota and build', async () => {
    const { ConflictError } = await import('@pipeline-builder/api-core') as any;
    mockAssertDeployable.mockRejectedValueOnce(new ConflictError('belongs to another author'));
    const res = mockRes();
    await expect(handler(mockReq('req-1:my-plugin'), res)).rejects.toMatchObject({ statusCode: 409 });

    expect(mockAssertDeployable).toHaveBeenCalledWith('org-1', 'my-plugin', '1.0.0', 'user-9', { isSystemAdmin: false, canPublish: false });
    expect(mockIdemReserve).not.toHaveBeenCalled();
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
  });

  it('snapshots the caller visibility authority into the build job for the worker re-check', async () => {
    await handler(mockReq(), mockRes());
    expect(mockCreateBuildJobData).toHaveBeenCalledWith(expect.objectContaining({ access: { isSystemAdmin: false, canPublish: false } }));
  });

  it('answers 503 (not 429) and releases the key when the quota service cannot confirm', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, unavailable: true, quota: { type: 'plugins', limit: 0, used: 0, remaining: 0 } });
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockIdemDelete).toHaveBeenCalled();
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
  });
});
