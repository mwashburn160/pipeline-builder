// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Idempotency-Key guard on POST /plugins/deploy-generated (#35/F4).
 *
 * The auto-plugin-creation path (generate-pipeline.ts) sends
 * `Idempotency-Key: <requestId>:<name>`; an SSE retry must NOT enqueue a
 * duplicate buildkit build or double the `plugins` quota. The route claims the
 * key via the Wave-1 Redis IdempotencyStore (SET…NX) BEFORE reserving quota or
 * enqueuing, and releases it on any pre-enqueue failure so a legit retry isn't
 * wrongly suppressed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
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
// F3: the route binds the build-log stream's owner at enqueue so a cross-org
// ticket mint for this requestId is refused.
const mockBindStreamOwner = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  getServiceAuthHeader: () => 'Bearer service-token',
  resolveAccessModifier: (_req: any, val: string) => val || 'private',
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
      accessModifier: 'private',
    },
  })),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string) => res.status(status).json({ message: msg })),
  sendQuotaExceeded: jest.fn((res: any) => res.status(429).json({ message: 'quota exceeded' })),
  sendSuccess: jest.fn((res: any, status: number, data?: any) => res.status(status).json({ success: true, data })),
  PluginDeployGeneratedSchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = req.context;
    await handler({ req, res, ctx, orgId: ctx.identity.orgId?.toLowerCase() || '', userId: ctx.identity.userId || '' });
  },
  getIdempotencyStore: () => ({ reserve: mockIdemReserve, delete: mockIdemDelete, get: mockIdemGet, set: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: (section: string) => (section === 'registry' ? { host: 'r', port: 5000, network: '', http: true } : {}) },
  CoreConstants: { IDEMPOTENCY_TTL_MS: 300000 },
}));

jest.unstable_mockModule('../src/helpers/docker-build.js', () => ({ BUILD_TEMP_ROOT: '/tmp/builds' }));
jest.unstable_mockModule('../src/helpers/plugin-helpers.js', () => ({ createBuildJobData: mockCreateBuildJobData }));
jest.unstable_mockModule('../src/helpers/plugin-spec.js', () => ({ validateBuildArgs: jest.fn() }));
jest.unstable_mockModule('../src/queue/plugin-build-queue.js', () => ({ enqueueBuild: mockEnqueueBuild, getOrgTier: mockGetOrgTier }));
jest.unstable_mockModule('../src/services/audit.js', () => ({ emitPluginAudit: mockEmitPluginAudit }));

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
    // F3: stream owner bound (requestId, orgId) before the build was queued.
    expect(mockBindStreamOwner).toHaveBeenCalledWith('req-1', 'org-1');
    expect(res.status).toHaveBeenCalledWith(202);
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

  it('releases the key when reserveQuota throws (quota service down)', async () => {
    // The reserveQuota await is the one post-claim await that used to sit outside
    // any releaseIdem path: a throw left the claim to persist for its TTL and
    // wrongly suppressed a legit retry. It must now release before rethrowing.
    mockReserveQuota.mockRejectedValueOnce(new Error('quota service unavailable'));
    const res = mockRes();
    await expect(handler(mockReq('req-1:my-plugin'), res)).rejects.toThrow('quota service unavailable');

    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
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

    // Rollback try releases the idem key AND refunds the reserved slot.
    expect(mockIdemDelete).toHaveBeenCalledWith('plugin:deploy-generated:org-1:req-1:my-plugin');
    expect(mockDecrementQuota).toHaveBeenCalled();
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
});
