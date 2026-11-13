// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The D14 initial-default route and the `deploy-bootstrap` identity gate
 * (docs/plans/bootstrap-image-versioning.md §5, D14), over the REAL app: the
 * real `createApp`, the real `mountRoutes` and the real api-core verifiers,
 * with real ES256 tokens — per-service keys for the service principals, a test
 * JWKS for users and service accounts.
 *
 * The `deploy-bootstrap` key is in the bundle every pod mounts, so the property
 * that matters is the negative one: its token is accepted on
 * `POST /plugins/toolchain/initial-default` and refused on EVERY other route
 * this service mounts — swept from the route table, not listed by hand.
 */

import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  type AnyFn, bindTestAuditService, generateTestSigningKey, installTestJwks, installTestServiceKeys, signTestUserToken, testUserIdentityClaims,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'toolchain-routes-test-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-toolchain-routes-'));
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

// The quota service the apiCalls check talks to (user tokens only; services skip it).
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

const serviceKeys = installTestServiceKeys(['plugin', 'deploy-bootstrap']);
const userKey = generateTestSigningKey();
installTestJwks([userKey]);

const mockSetPlatformDefault = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/toolchain-release-service.js', () => ({ setPlatformDefault: mockSetPlatformDefault }));
// The Toolchain console mounts on the same prefix and wraps this service; its gates are toolchain-console-routes.test.ts.
jest.unstable_mockModule('../src/services/toolchain-console-service.js', () => Object.fromEntries([
  'deleteConsoleRelease', 'deprecateConsoleRelease', 'getAffected', 'getCanary', 'getCleanupCandidates', 'getDefaultHistory', 'getReleaseAdoption',
  'listConsoleReleases', 'notifyAffected', 'previewDefault', 'promoteRelease', 'replaceRollout', 'setReleaseNotes', 'yankConsoleRelease',
].map((name) => [name, jest.fn<AnyFn>()])));

const { buildRouteTable, AppError, ErrorCode, SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');
const { createApp, attachRequestContext } = await import('@pipeline-builder/api-server');
const { createQuotaService } = await import('@pipeline-builder/api-core');
const { mountRoutes } = await import('../src/app-routes.js');

bindTestAuditService();

const { app, sseManager } = createApp({ enableOpenApi: false, logStream: true });
/** Routes createApp itself serves, mounted before (and outside) mountRoutes. */
const createAppRoutes = new Set(buildRouteTable(app).map((e) => `${e.method} ${e.path}`));
app.use(attachRequestContext(sseManager));
mountRoutes(app, { quotaService: createQuotaService(), sseManager });
const table = buildRouteTable(app);

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
  serviceKeys.uninstall();
});
beforeEach(() => {
  mockSetPlatformDefault.mockReset();
  mockSetPlatformDefault.mockImplementation(async (input: any) => ({ releaseVersion: input.releaseVersion, previousReleaseVersion: null, kind: 'initial', changed: true }));
});

/** The token deploy/bin/common.sh `sign_service_jwt` mints (same claims). */
const bootstrapToken = () => serviceKeys.sign('deploy-bootstrap', {
  role: 'admin', isAdmin: true, isSuperAdmin: true, organizationId: 'system', organizationName: 'system',
});
const userToken = (extra: Record<string, unknown> = {}) => signTestUserToken({
  ...testUserIdentityClaims(), sub: 'u-1', role: 'owner', isAdmin: true, isSuperAdmin: true, organizationId: SYSTEM_ORG_ID, ...extra,
}, { key: userKey });

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const INITIAL = '/plugins/toolchain/initial-default';

describe('POST /plugins/toolchain/initial-default', () => {
  it('accepts the deploy-bootstrap service principal and sets the initial default (no step-up)', async () => {
    const res = await call('POST', INITIAL, bootstrapToken(), { releaseVersion: '1.1.0' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { releaseVersion: '1.1.0' } });
    expect(mockSetPlatformDefault).toHaveBeenCalledWith({ releaseVersion: '1.1.0', kind: 'initial', actor: 'service:deploy-bootstrap' });
  });

  it('passes acceptVulnerabilities through', async () => {
    await call('POST', INITIAL, bootstrapToken(), { releaseVersion: '1.1.0', acceptVulnerabilities: 'tracked in #42' });
    expect(mockSetPlatformDefault).toHaveBeenCalledWith(expect.objectContaining({ acceptVulnerabilities: 'tracked in #42' }));
  });

  it('answers the service\'s typed refusal (a second call → 409 TOOLCHAIN_INITIAL_ALREADY_SET)', async () => {
    mockSetPlatformDefault.mockRejectedValue(new AppError(409, ErrorCode.TOOLCHAIN_INITIAL_ALREADY_SET, 'already set'));
    const res = await call('POST', INITIAL, bootstrapToken(), { releaseVersion: '1.1.0' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TOOLCHAIN_INITIAL_ALREADY_SET' });
  });

  it.each([
    ['a missing releaseVersion', {}],
    ['a prerelease', { releaseVersion: '1.1.0-dev.1' }],
    ['an empty override reason', { releaseVersion: '1.1.0', acceptVulnerabilities: ' ' }],
    ['an unknown field', { releaseVersion: '1.1.0', kind: 'set' }],
  ])('400 for %s', async (_name, body) => {
    const res = await call('POST', INITIAL, bootstrapToken(), body);
    expect(res.status).toBe(400);
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  });

  it('refuses a user — even a system-org superadmin owner (403)', async () => {
    const res = await call('POST', INITIAL, userToken(), { releaseVersion: '1.1.0' });
    expect(res.status).toBe(403);
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  });

  it('refuses a holder of toolchain:manage — the ORG default permission never reaches the platform default (403)', async () => {
    for (const orgId of ['aaaaaaaaaaaaaaaaaaaaaaa1', SYSTEM_ORG_ID]) {
      const res = await call('POST', INITIAL, userToken({ organizationId: orgId, role: 'admin', isSuperAdmin: false, permissions: ['toolchain:manage', 'pipelines:read'] }), { releaseVersion: '1.1.0' });
      expect([orgId, res.status]).toEqual([orgId, 403]);
    }
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  });

  it('refuses an org service account (403)', async () => {
    const res = await call('POST', INITIAL, userToken({ principalType: 'service_account', sub: 'sa-1' }), { releaseVersion: '1.1.0' });
    expect(res.status).toBe(403);
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  });

  it('refuses every other service principal (403)', async () => {
    const res = await call('POST', INITIAL, serviceKeys.sign('plugin', { role: 'admin', isAdmin: true, organizationId: SYSTEM_ORG_ID }), { releaseVersion: '1.1.0' });
    expect(res.status).toBe(403);
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  });

  it('refuses a forgery: deploy-bootstrap claims signed with another service\'s key (401)', async () => {
    const res = await call('POST', INITIAL, serviceKeys.signAs('plugin', 'deploy-bootstrap', { role: 'admin', organizationId: 'system' }), { releaseVersion: '1.1.0' });
    expect(res.status).toBe(401);
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  });

  it('401 with no token', async () => {
    expect((await call('POST', INITIAL, null, { releaseVersion: '1.1.0' })).status).toBe(401);
  });
});

describe('the deploy-bootstrap token everywhere else', () => {
  const others = table.filter((e) => e.method !== 'OPTIONS'
    && !(e.method === 'POST' && e.path === INITIAL)
    && !createAppRoutes.has(`${e.method} ${e.path}`));

  it('sweeps a real route table', () => {
    expect(others.length).toBeGreaterThan(100);
    // The org-default and Toolchain console routes share the prefix; the bootstrap token is refused there like everywhere else.
    expect(others.filter((e) => e.path.startsWith('/plugins/toolchain')).map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      'DELETE /plugins/toolchain/org-default', 'DELETE /plugins/toolchain/releases/:v',
      'GET /plugins/toolchain/affected', 'GET /plugins/toolchain/cleanup', 'GET /plugins/toolchain/eligible', 'GET /plugins/toolchain/history',
      'GET /plugins/toolchain/org-default', 'GET /plugins/toolchain/org-default/history',
      'GET /plugins/toolchain/releases', 'GET /plugins/toolchain/releases/:v/adoption', 'GET /plugins/toolchain/releases/:v/canary',
      'GET /plugins/toolchain/releases/:v/default-preview', 'PATCH /plugins/toolchain/releases/:v',
      'POST /plugins/toolchain/affected/notify', 'POST /plugins/toolchain/releases/:v/default',
      'POST /plugins/toolchain/releases/:v/deprecate', 'POST /plugins/toolchain/releases/:v/yank',
      'PUT /plugins/toolchain/org-default', 'PUT /plugins/toolchain/releases/:v/rollout',
    ]);
  });

  // deploy-bootstrap is an OPT-IN signer (api-core): every requireAuth that
  // does not name it in `acceptServices` rejects the token at verification
  // (401 TOKEN_INVALID). Once it is no longer trusted as a service principal
  // the global rate limiter stops skipping it too, so a long sweep can also
  // see 429 — either way the token is NEVER admitted. A 2xx/403/404 here would
  // mean some route reached its handler (or its own authz) with that token.
  const neverAdmitted = (res: { status: number; body?: { code?: string } }): boolean =>
    (res.status === 401 && res.body?.code === 'TOKEN_INVALID') || res.status === 429;

  it('is rejected at verification on every other route this service mounts', async () => {
    const admitted: string[] = [];
    for (const e of others) {
      const path = e.path.replace(/:[A-Za-z0-9_]+/g, 'x');
      const res = await call(e.method, path, bootstrapToken(), ['GET', 'DELETE'].includes(e.method) ? undefined : {});
      if (!neverAdmitted(res)) admitted.push(`${e.method} ${e.path} → ${res.status} ${res.body?.code ?? ''}`);
    }
    expect(admitted).toEqual([]);
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  }, 60_000);

  it('is never admitted on the initial route under another method or path', async () => {
    for (const res of [await call('GET', INITIAL, bootstrapToken()), await call('POST', '/plugins/toolchain/other', bootstrapToken(), {})]) {
      expect(res.status).not.toBeLessThan(400);
      expect([401, 404, 429]).toContain(res.status);
    }
    expect(mockSetPlatformDefault).not.toHaveBeenCalled();
  });

  it('other identities still reach the other routes (the refusal is that identity only)', async () => {
    const res = await call('GET', '/plugins/storage', userToken({ organizationId: 'org-1', isSuperAdmin: false, permissions: [] }));
    expect(res.body?.message ?? '').not.toMatch(/deploy-bootstrap/);
  });
});
