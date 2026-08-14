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
  getIdempotencyStore: () => ({ reserve: mockIdemReserve, delete: mockIdemDelete, get: jest.fn(), set: jest.fn() }),
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
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'plugins', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } });
    mockValidatePlugin.mockResolvedValue({ blocked: false, violations: [], warnings: [] });
  });

  it('claims the key BEFORE reserving quota and queues the build on first request', async () => {
    const res = mockRes();
    await handler(mockReq('req-1:my-plugin'), res);

    // Key claimed under the org-namespaced deploy-generated prefix.
    expect(mockIdemReserve).toHaveBeenCalledWith(
      'plugin:deploy-generated:org-1:req-1:my-plugin',
      expect.objectContaining({ pending: true }),
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
