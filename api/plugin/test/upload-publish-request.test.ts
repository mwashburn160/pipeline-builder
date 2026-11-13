// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The upload's `publishRequest=true`: refused up front
 * without `plugins:publish` or a `public` version; for an image-less plugin the
 * request is submitted right after the deploy; for an image plugin the caller
 * is snapshotted into the build job so the worker submits it after the build.
 */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-upload-publish-'));
process.env.PLUGIN_UPLOAD_DIR = uploadDir;

const mockEnqueueBuild = jest.fn<(...a: any[]) => Promise<void>>(async () => undefined);
const mockDeployVersion = jest.fn<(...a: any[]) => Promise<any>>(async () => ({ id: 'p-1' }));
const mockSubmitAfterBuild = jest.fn<(...a: any[]) => Promise<any>>(async () => ({ ok: true, message: 'Publish request submitted', requestId: 'r-1', status: 'pending' }));
const producesImage = { value: false };
const spec = { value: { name: 'lint', version: '1.0.0', commands: ['lint'], description: 'Lints.' } as Record<string, unknown> };
const mockOrgId = { value: 'org-1' };

// The CPU-credit admission gate fails CLOSED when the quota service cannot
// answer (D6). This suite's quota double does not implement `check`, so without
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
  reserveQuota: async () => ({ exceeded: false, quota: { resetAt: '2026-09-24T00:00:00.000Z', used: 1, limit: 10 } }),
  decrementQuota: jest.fn(),
  resolveVisibility: (_req: unknown, v: string | undefined) => v ?? 'org',
  userHasPermission: (req: any, p: string) => (req.user?.permissions ?? []).includes(p),
  createComplianceClient: () => ({ validatePlugin: async () => ({ blocked: false, violations: [], warnings: [] }) }),
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
    withRoute: (handler: (a: unknown) => Promise<void>) => async (req: any, res: any) =>
      handler({ req, res, ctx: { log: jest.fn(), requestId: 'req-1' }, orgId: mockOrgId.value, userId: 'user-1' }),
  });
});
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
  CoreConstants: { PLUGIN_MAX_UPLOAD_MB: 1 },
}));
jest.unstable_mockModule('../src/helpers/plugin-spec.js', () => ({
  parsePluginZip: async () => ({
    pluginSpec: spec.value,
    extractDir: fs.mkdtempSync(path.join(uploadDir, 'x-')),
    dockerfile: 'Dockerfile',
    dockerfileContent: null,
    buildType: 'metadata_only',
    readmeMd: null,
  }),
  validateBuildArgs: jest.fn(),
  specContractFields: () => ({ requiredMetadata: [], requiredVars: [], metadataTypes: {}, varsTypes: {}, smokeTest: null, networkEgress: [] }),
}));
jest.unstable_mockModule('../src/helpers/build-strategy.js', () => ({ getBuildStrategy: () => ({ producesImage: producesImage.value }) }));
jest.unstable_mockModule('../src/queue/connections.js', () => ({ enqueueBuild: mockEnqueueBuild, getOrgTier: jest.fn(async () => 'developer') }));
jest.unstable_mockModule('../src/services/plugin-artifact-storage.js', () => ({
  putPluginArtifact: jest.fn(async () => undefined), deletePluginArtifact: jest.fn(), pluginArtifactKey: () => 'org-1/req-1.zip',
}));
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { assertDeployable: jest.fn(async () => undefined), deployVersion: mockDeployVersion },
}));
jest.unstable_mockModule('../src/services/ecosystem/requests.js', () => ({ submitAfterBuild: mockSubmitAfterBuild }));

({ withQuotaReservation: realWithQuotaReservation } = await import('@pipeline-builder/api-server/lib/api/quota-reservation.js'));
const { createUploadPluginRoutes } = await import('../src/routes/upload-plugin.js');
const router = createUploadPluginRoutes({} as any, { bindStreamOwner: jest.fn(async () => undefined) } as any);
const upload = (() => {
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/' && l.route?.methods?.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();

afterAll(() => fs.rmSync(uploadDir, { recursive: true, force: true }));

function call(body: Record<string, unknown>, permissions: string[]) {
  const tempPath = path.join(uploadDir, `m-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tempPath, 'PK');
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  const req = { headers: {}, body, user: { sub: 'user-1', organizationId: 'org-1', principalType: 'service_account', username: 'official-catalog-loader', permissions }, file: { path: tempPath, originalname: 'p.zip', size: 2 } };
  return { res, done: upload(req, res) as Promise<void> };
}

beforeEach(() => {
  jest.clearAllMocks();
  producesImage.value = false;
  spec.value = { name: 'lint', version: '1.0.0', commands: ['lint'], description: 'Lints.' };
  mockOrgId.value = 'org-1';
});

describe('POST /plugins with publishRequest=true', () => {
  it('needs plugins:publish', async () => {
    const { res, done } = call({ publishRequest: 'true', visibility: 'public' }, ['plugins:write']);
    await done;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDeployVersion).not.toHaveBeenCalled();
  });

  it('needs a public version', async () => {
    const { res, done } = call({ publishRequest: 'true', visibility: 'org' }, ['plugins:write', 'plugins:publish']);
    await done;
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('submits the request right after an image-less deploy and returns its outcome', async () => {
    const { res, done } = call({ publishRequest: 'true', visibility: 'public' }, ['plugins:write', 'plugins:publish']);
    await done;
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockSubmitAfterBuild).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', principalType: 'service_account', name: 'official-catalog-loader' }), 'p-1');
    expect(res.json.mock.calls[0][0].data.publishRequest).toMatchObject({ ok: true, requestId: 'r-1' });
  });

  it('snapshots the caller into the build job for an image plugin', async () => {
    producesImage.value = true;
    const { res, done } = call({ publishRequest: 'true', visibility: 'public' }, ['plugins:write', 'plugins:publish']);
    await done;
    expect(res.status).toHaveBeenCalledWith(202);
    expect(mockEnqueueBuild.mock.calls[0]![2]).toMatchObject({ publish: { caller: expect.objectContaining({ userId: 'user-1', orgId: 'org-1' }) } });
    expect(mockSubmitAfterBuild).not.toHaveBeenCalled();
  });

  it('leaves an ordinary upload alone', async () => {
    const { res, done } = call({ visibility: 'public' }, ['plugins:write', 'plugins:publish']);
    await done;
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockSubmitAfterBuild).not.toHaveBeenCalled();
  });
});

// docs/plans/bootstrap-image-versioning.md §5 — the upload entry point for the
// managed toolchain names (pipeline-bootstrap, cdk-synth).
describe('POST /plugins with a managed toolchain name', () => {
  const { SYSTEM_ORG_ID } = jest.requireActual('@pipeline-builder/api-core') as { SYSTEM_ORG_ID: string };
  const publisher = ['plugins:write', 'plugins:publish'];

  it('refuses a customer org with 403 PLUGIN_MANAGED_NAME_RESERVED', async () => {
    spec.value = { name: 'cdk-synth', version: '1.0.0', commands: ['cdk synth'] };
    const { done } = call({ visibility: 'public' }, publisher);
    await expect(done).rejects.toMatchObject({ statusCode: 403, code: 'PLUGIN_MANAGED_NAME_RESERVED' });
    expect(mockDeployVersion).not.toHaveBeenCalled();
  });

  it('refuses publishRequest=true from the system org with 400 PLUGIN_MANAGED_NOT_LISTABLE', async () => {
    mockOrgId.value = SYSTEM_ORG_ID;
    spec.value = { name: 'pipeline-bootstrap', version: '1.0.0', pluginType: 'BuildImage' };
    const { done } = call({ publishRequest: 'true', visibility: 'public' }, publisher);
    await expect(done).rejects.toMatchObject({ statusCode: 400, code: 'PLUGIN_MANAGED_NOT_LISTABLE' });
    expect(mockDeployVersion).not.toHaveBeenCalled();
    expect(mockSubmitAfterBuild).not.toHaveBeenCalled();
  });

  it('refuses a prerelease with 400 PLUGIN_MANAGED_PRERELEASE', async () => {
    mockOrgId.value = SYSTEM_ORG_ID;
    spec.value = { name: 'pipeline-bootstrap', version: '1.1.0-dev.3', pluginType: 'BuildImage' };
    const { done } = call({ visibility: 'public' }, publisher);
    await expect(done).rejects.toMatchObject({ statusCode: 400, code: 'PLUGIN_MANAGED_PRERELEASE' });
    expect(mockDeployVersion).not.toHaveBeenCalled();
  });

  it('accepts a plain release from the system org without a publish request', async () => {
    mockOrgId.value = SYSTEM_ORG_ID;
    spec.value = { name: 'pipeline-bootstrap', version: '1.1.0', pluginType: 'BuildImage' };
    const { res, done } = call({ visibility: 'public' }, publisher);
    await done;
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockSubmitAfterBuild).not.toHaveBeenCalled();
  });
});
