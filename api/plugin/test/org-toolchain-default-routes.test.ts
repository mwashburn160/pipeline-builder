// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org toolchain default routes' GATES (docs/plans/bootstrap-image-versioning.md
 * §5, Phase 4, D13), over the REAL app: the real `createApp`, `mountRoutes`,
 * api-core verifiers, `requirePermission` and `requireStepUp`, with real ES256
 * user and step-up tokens. The service is replaced — what it does with the
 * database is org-toolchain-default-service.test.ts.
 *
 *  - writes need `toolchain:manage` AND a step-up, even with the org's MFA
 *    policy off (`org_admin_aal` absent); `pipelines:write` and
 *    `plugin_installs:manage` give nothing here; a service account never passes;
 *  - reads need only `pipelines:read` and never a step-up;
 *  - every route acts on the CALLER's org (no route takes an org id).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  type AnyFn, bindTestAuditService, generateTestSigningKey, installTestJwks, signTestUserToken, testUserIdentityClaims,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'org-toolchain-default-routes-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-org-toolchain-'));
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

const quotaStub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { status: { allowed: true, limit: -1, used: 0, remaining: -1, resetAt: '2026-12-01T00:00:00.000Z', unlimited: true }, quota: {} } }));
  });
});
await new Promise<void>((resolve) => quotaStub.listen(0, '127.0.0.1', () => resolve()));
process.env.QUOTA_SERVICE_HOST = '127.0.0.1';
process.env.QUOTA_SERVICE_PORT = String((quotaStub.address() as { port: number }).port);

const userKey = generateTestSigningKey();
installTestJwks([userKey]);

const svc = {
  getOrgToolchainPanel: jest.fn<AnyFn>(),
  setOrgToolchainDefault: jest.fn<AnyFn>(),
  clearOrgToolchainDefault: jest.fn<AnyFn>(),
  getOrgToolchainHistory: jest.fn<AnyFn>(),
  getEligibleToolchainReleases: jest.fn<AnyFn>(),
};
jest.unstable_mockModule('../src/services/org-toolchain-default-service.js', () => svc);

const { AppError, ErrorCode, createQuotaService } = await import('@pipeline-builder/api-core');
const { createApp, attachRequestContext } = await import('@pipeline-builder/api-server');
const { mountRoutes } = await import('../src/app-routes.js');

bindTestAuditService();
const { app, sseManager } = createApp({ enableOpenApi: false, logStream: true });
app.use(attachRequestContext(sseManager));
mountRoutes(app, { quotaService: createQuotaService(), sseManager });

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => quotaStub.close(() => resolve()));
});

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const ORG_DEFAULT = { releaseVersion: '1.4.2', setBy: 'u-1', setAt: '2026-11-01T00:00:00.000Z', reason: null };
const PANEL = {
  effective: { releaseVersion: '1.4.2', resolvedVia: 'org-default' },
  orgDefault: ORG_DEFAULT,
  inheritedFrom: null,
  canary: { member: false, releaseVersion: null, effective: false },
  platformDefault: '1.5.0',
  counts: { pipelines: 3, pinned: 1, behind: 2 },
};

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.getOrgToolchainPanel.mockResolvedValue(PANEL);
  svc.setOrgToolchainDefault.mockResolvedValue({ orgDefault: ORG_DEFAULT, previousReleaseVersion: null, warnings: [] });
  svc.clearOrgToolchainDefault.mockResolvedValue({ previousReleaseVersion: '1.4.2' });
  svc.getOrgToolchainHistory.mockResolvedValue({ history: [{ releaseVersion: null, setBy: 'u-1', setAt: '2026-11-02T00:00:00.000Z', reason: null }] });
  svc.getEligibleToolchainReleases.mockResolvedValue({ platformDefault: '1.5.0', releases: [] });
});

/** A user access token holding exactly `permissions` (the org MFA policy is OFF: no `org_admin_aal`). */
const userToken = (permissions: string[], extra: Record<string, unknown> = {}) => signTestUserToken({
  ...testUserIdentityClaims(), sub: 'u-1', role: 'member', organizationId: ORG, permissions, ...extra,
}, { key: userKey });
const stepUpToken = (sub = 'u-1') => signTestUserToken({ type: 'step-up', sub, jti: randomUUID() }, { key: userKey, expiresIn: 60 });

async function call(method: string, path: string, token: string, opts: { body?: unknown; stepUp?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.stepUp ? { 'x-step-up-token': opts.stepUp } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const PATH = '/plugins/toolchain/org-default';
const MEMBER = ['pipelines:read', 'pipelines:write', 'pipeline_registry:write', 'plugins:read', 'plugins:write', 'plugins:install'];

describe('reads: pipelines:read, never a step-up', () => {
  it.each([
    ['GET', PATH, 'getOrgToolchainPanel', PANEL],
    ['GET', `${PATH}/history`, 'getOrgToolchainHistory', { history: [{ releaseVersion: null }] }],
    ['GET', '/plugins/toolchain/eligible', 'getEligibleToolchainReleases', { platformDefault: '1.5.0', releases: [] }],
  ] as const)('%s %s — a Member reads it for its own org, with no step-up token', async (method, path, fn, data) => {
    const res = await call(method, path, userToken(MEMBER));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data });
    expect(svc[fn]).toHaveBeenCalledWith({ orgId: ORG, userId: 'u-1' });
  });

  it('403 without pipelines:read (toolchain:manage alone is not a read grant)', async () => {
    for (const path of [PATH, `${PATH}/history`, '/plugins/toolchain/eligible']) {
      const res = await call('GET', path, userToken(['toolchain:manage']));
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect(svc.getOrgToolchainPanel).not.toHaveBeenCalled();
  });
});

describe('writes: toolchain:manage + requireStepUp', () => {
  const put = (token: string, stepUp?: string, body: unknown = { releaseVersion: '1.4.2', reason: 'stay on 1.4' }) =>
    call('PUT', PATH, token, { body, ...(stepUp ? { stepUp } : {}) });
  const del = (token: string, stepUp?: string) => call('DELETE', PATH, token, stepUp ? { stepUp } : {});

  it('a custom Role holding toolchain:manage sets the default (own org) with a step-up', async () => {
    const res = await put(userToken(['toolchain:manage']), stepUpToken());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, statusCode: 200, data: { orgDefault: ORG_DEFAULT } });
    expect(svc.setOrgToolchainDefault).toHaveBeenCalledWith({ orgId: ORG, userId: 'u-1' }, { releaseVersion: '1.4.2', reason: 'stay on 1.4' });
  });

  it('answers the warnings a vulnerable-but-eligible release carries', async () => {
    const warnings = [{ code: 'TOOLCHAIN_RELEASE_VULNERABLE', severity: 'warning', message: 'm' }];
    svc.setOrgToolchainDefault.mockResolvedValue({ orgDefault: ORG_DEFAULT, previousReleaseVersion: '1.3.0', warnings });
    const res = await put(userToken(['toolchain:manage']), stepUpToken());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ orgDefault: ORG_DEFAULT, warnings });
  });

  it('an ineligible release is the service\'s 400 TOOLCHAIN_RELEASE_NOT_ELIGIBLE', async () => {
    svc.setOrgToolchainDefault.mockRejectedValue(new AppError(400, ErrorCode.TOOLCHAIN_RELEASE_NOT_ELIGIBLE, 'not eligible', { releaseVersion: '1.4.2' }));
    const res = await put(userToken(['toolchain:manage']), stepUpToken());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOOLCHAIN_RELEASE_NOT_ELIGIBLE' });
  });

  it.each([
    ['a missing releaseVersion', {}],
    ['a prerelease', { releaseVersion: '1.4.2-dev.1' }],
    ['an org id in the body (every route acts on the caller\'s own org)', { releaseVersion: '1.4.2', orgId: 'bbbbbbbbbbbbbbbbbbbbbbb1' }],
  ])('400 for %s', async (_name, body) => {
    const res = await put(userToken(['toolchain:manage']), stepUpToken(), body);
    expect(res.status).toBe(400);
    expect(svc.setOrgToolchainDefault).not.toHaveBeenCalled();
  });

  it('clear: data { orgDefault: null }', async () => {
    const res = await del(userToken(['toolchain:manage']), stepUpToken());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ orgDefault: null });
    expect(svc.clearOrgToolchainDefault).toHaveBeenCalledWith({ orgId: ORG, userId: 'u-1' });
  });

  it('step-up is required even with the org MFA policy off — and the read gate never asks for one', async () => {
    for (const res of [await put(userToken(['toolchain:manage'])), await del(userToken(['toolchain:manage']))]) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
    expect(svc.setOrgToolchainDefault).not.toHaveBeenCalled();
    expect(svc.clearOrgToolchainDefault).not.toHaveBeenCalled();
  });

  it('a step-up token is single-use and bound to the caller', async () => {
    const token = stepUpToken();
    expect((await put(userToken(['toolchain:manage']), token)).status).toBe(200);
    expect((await put(userToken(['toolchain:manage']), token)).body).toMatchObject({ code: 'STEP_UP_REPLAY' });
    expect((await put(userToken(['toolchain:manage']), stepUpToken('u-2'))).body).toMatchObject({ code: 'STEP_UP_MISMATCH' });
  });

  it.each([
    ['a Member (pipelines:write and every member permission)', MEMBER],
    ['plugin_installs:manage alone', ['plugin_installs:manage']],
    ['pipelines:write alone', ['pipelines:write']],
    ['org_settings:write', ['org_settings:write', 'pipelines:read']],
  ])('403 for %s, even with a step-up', async (_name, permissions) => {
    expect((await put(userToken(permissions), stepUpToken())).status).toBe(403);
    expect((await del(userToken(permissions), stepUpToken())).status).toBe(403);
    expect(svc.setOrgToolchainDefault).not.toHaveBeenCalled();
    expect(svc.clearOrgToolchainDefault).not.toHaveBeenCalled();
  });

  it('a service account holding toolchain:manage never passes the step-up (403 STEP_UP_NOT_AVAILABLE)', async () => {
    const sa = userToken(['toolchain:manage'], { principalType: 'service_account', sub: 'sa-1' });
    const res = await put(sa, stepUpToken('sa-1'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'STEP_UP_NOT_AVAILABLE' });
    expect(svc.setOrgToolchainDefault).not.toHaveBeenCalled();
  });
});
