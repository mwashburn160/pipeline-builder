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
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-upload-'));
process.env.PLUGIN_UPLOAD_DIR = uploadDir;

const mockValidateBody = jest.fn<(...a: any[]) => any>();
const mockReserveQuota = jest.fn<(...a: any[]) => Promise<any>>();
const mockParsePluginZip = jest.fn<(...a: any[]) => Promise<any>>();
const mockDecrementQuota = jest.fn<(...a: any[]) => Promise<any>>(async () => undefined);
const mockShadowingDecision = jest.fn<(...a: any[]) => Promise<any>>(async () => ({ mode: 'warn', shadows: [] }));

// The CPU-credit admission gate fails CLOSED when the quota service cannot
// answer. This suite's quota double does not implement `check`, so without
// this stub every upload here would be refused on credits before reaching the
// behaviour under test. Credits have their own suite (`build-credits.test.ts`).
jest.unstable_mockModule('../src/queue/build-credits.js', () => ({
  admitBuildOnCredits: jest.fn(async () => ({ admitted: true })),
  chargeBuildCredits: jest.fn(async () => undefined),
  buildTrigger: () => 'user',
  creditsForBuild: () => 0,
  buildSpendsCredits: () => true,
  failedBuildIsCharged: () => false,
  BUILDKIT_VCPU: 1.5,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  validateBody: mockValidateBody,
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  resolveVisibility: () => 'org',
  PluginUploadBodySchema: {},
}));

// The REAL reservation helper (its api-core calls hit this file's api-core mock).
let realWithQuotaReservation: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return stubModule('@pipeline-builder/api-server', {
    withQuotaReservation: (...a: any[]) => realWithQuotaReservation(...a),
    requireOrgId: () => pass,
    withTenantContext: () => pass,
    rateLimitByOrg: () => pass,
    withRoute: (handler: Function) => async (req: any, res: any) =>
      handler({ req, res, ctx: { log: jest.fn(), requestId: 'req-1' }, orgId: 'org-1', userId: 'user-1' }),
  });
});

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
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
jest.unstable_mockModule('../src/queue/connections.js', () => ({ enqueueBuild: jest.fn(), getOrgTier: jest.fn(async () => 'developer') }));
jest.unstable_mockModule('../src/services/plugin-artifact-storage.js', () => ({
  putPluginArtifact: jest.fn(), putPluginArtifactFile: jest.fn(), deletePluginArtifact: jest.fn(), pluginArtifactKey: () => 'k',
}));
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { assertDeployable: jest.fn(async () => undefined), deployVersion: jest.fn() },
}));

// The ecosystem graph (publish-request submission) is not under test here.
jest.unstable_mockModule('../src/services/ecosystem/context.js', () => ({ callerFromRequest: jest.fn() }));
jest.unstable_mockModule('../src/services/ecosystem/requests.js', () => ({ submitAfterBuild: jest.fn() }));
jest.unstable_mockModule('../src/services/ecosystem/installs.js', () => ({
  shadowingDecision: mockShadowingDecision,
}));

({ withQuotaReservation: realWithQuotaReservation } = await import('@pipeline-builder/api-server/lib/api/quota-reservation.js'));
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

// P1: a `deny` shadowing refusal was the ONLY early return in the reservation
// body that kept its `plugins` slot, so an org retrying a refused name ran
// itself out of quota.
describe('POST /plugins — name-shadowing refusal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({ ok: true, value: {} });
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { resetAt: 'P' } });
    mockParsePluginZip.mockResolvedValue({
      pluginSpec: { name: 'trivy', version: '1.0.0', buildArgs: {} },
      buildType: 'build_image',
      readmeMd: null,
      dockerfileContent: 'FROM scratch',
    });
  });

  it('answers 409 PLUGIN_NAME_SHADOWS and REFUNDS the plugins slot', async () => {
    mockShadowingDecision.mockResolvedValue({ mode: 'deny', shadows: ['official/trivy'] });
    const { req, tempPath } = uploadReq();
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('would override official/trivy') }));
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockDecrementQuota.mock.calls[0]).toEqual(expect.arrayContaining(['plugins']));
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});

// The parsed zip's extract dir used to be left on the build-scratch volume by
// every outcome that queued no build (a refusal, a throw), until the stale-temp
// sweep — only a queued build job ever cleaned it up.
describe('POST /plugins — extract dir cleanup', () => {
  function extracted(): string {
    const dir = fs.mkdtempSync(path.join(uploadDir, 'extract-'));
    fs.writeFileSync(path.join(dir, 'plugin-spec.yaml'), 'name: trivy');
    mockParsePluginZip.mockResolvedValue({
      pluginSpec: { name: 'trivy', version: '1.0.0', buildArgs: {} },
      buildType: 'build_image',
      readmeMd: null,
      dockerfileContent: 'FROM scratch',
      extractDir: dir,
    });
    return dir;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({ ok: true, value: {} });
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { resetAt: 'P' } });
  });

  it('removes the extract dir when the upload is refused after parsing', async () => {
    const dir = extracted();
    mockShadowingDecision.mockResolvedValue({ mode: 'deny', shadows: ['official/trivy'] });
    const res = mockRes();

    await handler(uploadReq().req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes the extract dir when processing throws after parsing', async () => {
    const dir = extracted();
    const { pluginService } = await import('../src/services/plugin-service.js');
    (pluginService.assertDeployable as jest.Mock<(...a: any[]) => Promise<any>>).mockRejectedValueOnce(new Error('not deployable'));

    await expect(handler(uploadReq().req, mockRes())).rejects.toThrow('not deployable');

    expect(fs.existsSync(dir)).toBe(false);
  });
});

// The multipart error handler runs instead of the handler when multer refuses
// the body. An over-size ZIP is a 413 (as on the anonymous submission path),
// not a generic 400 — and its partial temp file is still removed.
describe('POST /plugins — multipart errors', () => {
  const errorLayer = (routePath: string) => {
    const l = (router.stack as any[]).find((x) => x.route?.path === routePath && x.route?.methods?.post);
    return l.route.stack.find((s: any) => s.handle.length === 4).handle;
  };

  it.each(['/', '/inspect'])('answers an over-size upload to %s with 413 and removes the partial file', async (routePath) => {
    const { req, tempPath } = uploadReq();
    const res = mockRes();
    const next = jest.fn();
    const err = Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' });

    errorLayer(routePath)(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(next).not.toHaveBeenCalled();
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('answers any other multipart failure with 400', () => {
    const { req } = uploadReq();
    const res = mockRes();
    errorLayer('/')(new Error('Unexpected end of form'), req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// api-server cuts every request at 25 s; the upload extends its socket timeout
// before multer reads the body. The inspect dry-run takes the SAME (up to 4 GiB)
// ZIP — nginx gives it 300 s — but did not, so any inspect whose body took over
// 25 s to stream answered 503 "Request timeout" before the dialog's catalog step.
describe('POST /plugins/inspect — upload timeout', () => {
  it.each(['/', '/inspect'])('%s extends the socket timeout before reading the body', (routePath) => {
    const l = (router.stack as any[]).find((x) => x.route?.path === routePath && x.route?.methods?.post);
    const first = l.route.stack[0].handle;
    const req: any = { setTimeout: jest.fn() };
    const res: any = { setTimeout: jest.fn() };
    const next = jest.fn();

    first(req, res, next);

    expect(res.setTimeout).toHaveBeenCalledWith(900_000);
    expect(req.setTimeout).toHaveBeenCalledWith(900_000);
    expect(next).toHaveBeenCalled();
  });
});
