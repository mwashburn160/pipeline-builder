// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /plugins (upload) — the multer temp ZIP is removed on EVERY outcome.
 *
 * The handler's `finally` used to unlink only a `zipPath` assigned AFTER body
 * validation and the quota reservation, so a request rejected before that point
 * (bad body, quota denied) leaked its multi-GB temp file on the upload volume —
 * and nothing else sweeps that directory. These tests drive the real handler
 * against a real temp file on disk.
 */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-upload-'));
process.env.PLUGIN_UPLOAD_DIR = uploadDir;

const mockValidateBody = jest.fn<(...a: any[]) => any>();
const mockReserveQuota = jest.fn<(...a: any[]) => Promise<any>>();
const mockParsePluginZip = jest.fn<(...a: any[]) => Promise<any>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  validateBody: mockValidateBody,
  reserveQuota: mockReserveQuota,
  decrementQuota: jest.fn(),
  resolveVisibility: () => 'org',
  PluginUploadBodySchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    requireAuth: pass,
    requireOrgId: () => pass,
    withTenantContext: () => pass,
    rateLimitByOrg: () => pass,
    withRoute: (handler: Function) => async (req: any, res: any) =>
      handler({ req, res, ctx: { log: jest.fn(), requestId: 'req-1' }, orgId: 'org-1', userId: 'user-1' }),
  };
});

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({}) },
  CoreConstants: { PLUGIN_MAX_UPLOAD_MB: 1 },
}));
jest.unstable_mockModule('../src/helpers/plugin-spec.js', () => ({
  parsePluginZip: mockParsePluginZip,
  validateBuildArgs: jest.fn(),
  specContractFields: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../src/helpers/plugin-helpers.js', () => ({ createBuildJobData: (p: unknown) => p, toPluginInsert: (p: unknown) => p }));
jest.unstable_mockModule('../src/helpers/build-strategy.js', () => ({ getBuildStrategy: () => ({ producesImage: true }) }));
jest.unstable_mockModule('../src/queue/connections.js', () => ({ enqueueBuild: jest.fn(), getOrgTier: jest.fn() }));
jest.unstable_mockModule('../src/services/audit.js', () => ({ emitPluginAudit: jest.fn() }));
jest.unstable_mockModule('../src/services/plugin-artifact-storage.js', () => ({
  putPluginArtifact: jest.fn(), deletePluginArtifact: jest.fn(), pluginArtifactKey: () => 'k',
}));
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { assertDeployable: jest.fn(async () => undefined), deployVersion: jest.fn() },
}));

const { createUploadPluginRoutes } = await import('../src/routes/upload-plugin.js');

const router = createUploadPluginRoutes({} as any, {} as any);
const layer = (router.stack as any[]).find((l) => l.route?.path === '/' && l.route?.methods?.post);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

afterAll(() => fs.rmSync(uploadDir, { recursive: true, force: true }));

/** A request carrying a multer temp file that really exists on disk. */
function uploadReq(): { req: any; tempPath: string } {
  const tempPath = path.join(uploadDir, `multer-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tempPath, 'PK not really a zip');
  return {
    tempPath,
    req: { headers: {}, body: {}, user: { sub: 'user-1' }, file: { path: tempPath, originalname: 'p.zip', size: 10 } },
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  return res;
}

describe('POST /plugins — temp upload cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({ ok: true, value: {} });
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { resetAt: 'P' } });
  });

  it('removes the temp ZIP when the body fails validation (early return)', async () => {
    mockValidateBody.mockReturnValue({ ok: false, error: 'bad body' });
    const { req, tempPath } = uploadReq();
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('removes the temp ZIP when the quota reservation is denied (early return)', async () => {
    mockReserveQuota.mockResolvedValue({ exceeded: true, quota: { limit: 1, used: 1 } });
    const { req, tempPath } = uploadReq();
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('removes the temp ZIP when processing throws', async () => {
    mockParsePluginZip.mockRejectedValue(new Error('corrupt zip'));
    const { req, tempPath } = uploadReq();

    await expect(handler(req, mockRes())).rejects.toThrow('corrupt zip');

    expect(fs.existsSync(tempPath)).toBe(false);
  });
});
