// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Toolchain console routes' GATES and wire contract
 * (docs/plans/bootstrap-image-versioning.md §5, §11, D9, Phase 5), over the
 * REAL app: the real `createApp`, `mountRoutes`, api-core verifiers,
 * `requireSystemOrgPermission` and `requireStepUp`, with real ES256 user and
 * step-up tokens. The service is replaced — what it does with the database is
 * toolchain-console-service.test.ts.
 *
 *  - every route: system org + `toolchain:operate` + aal2. A tenant Admin (even
 *    one whose token claimed `toolchain:operate`), a system-org `toolchain:manage`
 *    holder and an aal1 session all get 403;
 *  - reads never step up; every write needs a step-up;
 *  - bodies / params are validated, and service refusals pass through with
 *    their codes and details.
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

process.env.JWT_SECRET ||= 'toolchain-console-routes-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-toolchain-console-'));
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
  listConsoleReleases: jest.fn<AnyFn>(),
  getReleaseAdoption: jest.fn<AnyFn>(),
  getCanary: jest.fn<AnyFn>(),
  replaceRollout: jest.fn<AnyFn>(),
  previewDefault: jest.fn<AnyFn>(),
  promoteRelease: jest.fn<AnyFn>(),
  setReleaseNotes: jest.fn<AnyFn>(),
  deprecateConsoleRelease: jest.fn<AnyFn>(),
  yankConsoleRelease: jest.fn<AnyFn>(),
  deleteConsoleRelease: jest.fn<AnyFn>(),
  getDefaultHistory: jest.fn<AnyFn>(),
  getAffected: jest.fn<AnyFn>(),
  notifyAffected: jest.fn<AnyFn>(),
  getCleanupCandidates: jest.fn<AnyFn>(),
};
jest.unstable_mockModule('../src/services/toolchain-console-service.js', () => svc);

const { AppError, ROLE_PERMISSIONS, ErrorCode, SYSTEM_ORG_ID, createQuotaService } = await import('@pipeline-builder/api-core');
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

const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const RELEASES = { platformDefault: '1.0.0', releases: [] };
const MEMBERS = { members: [{ orgId: TENANT, orgName: 'Acme', hasOrgDefault: false }], added: [TENANT], removed: [], moved: [] };

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.listConsoleReleases.mockResolvedValue(RELEASES);
  svc.getReleaseAdoption.mockResolvedValue({ releaseVersion: '1.1.0', byResolvedVia: { 'pin': 0, 'org-default': 0, 'canary': 1, 'default': 0 }, orgs: [] });
  svc.getCanary.mockResolvedValue({ members: [], gate: { passes: false } });
  svc.replaceRollout.mockResolvedValue(MEMBERS);
  svc.previewDefault.mockResolvedValue({ blastRadius: { followingPipelines: 3, followingOrgs: 2, orgsWithOwnDefault: 1, pinnedPipelines: 1 }, guards: [], currentDefault: '1.0.0' });
  svc.promoteRelease.mockResolvedValue({ platformDefault: '1.1.0', changed: true });
  svc.setReleaseNotes.mockResolvedValue({ releaseVersion: '1.1.0', releaseNotes: 'n' });
  svc.deprecateConsoleRelease.mockResolvedValue(undefined);
  svc.yankConsoleRelease.mockResolvedValue({ restoredDefault: '1.0.0' });
  svc.deleteConsoleRelease.mockResolvedValue(undefined);
  svc.getDefaultHistory.mockResolvedValue({ history: [] });
  svc.getAffected.mockResolvedValue({ releaseVersion: '1.1.0', orgs: [] });
  svc.notifyAffected.mockResolvedValue({ notifiedOrgs: 1, notifiedPipelines: 2 });
  svc.getCleanupCandidates.mockResolvedValue({ candidates: [] });
});

/** An aal2 user token in `org` holding exactly `permissions`. */
const token = (permissions: readonly string[], opts: { org?: string; aal?: number; sub?: string } = {}) => signTestUserToken({
  ...testUserIdentityClaims(),
  sub: opts.sub ?? 'u-op',
  role: 'member',
  organizationId: opts.org ?? SYSTEM_ORG_ID,
  permissions: [...permissions],
  aal: opts.aal ?? 2,
  amr: ['pwd', 'mfa'],
}, { key: userKey });
const stepUpToken = (sub = 'u-op') => signTestUserToken({ type: 'step-up', sub, jti: randomUUID() }, { key: userKey, expiresIn: 60 });
const OPERATOR = ['toolchain:operate'];

async function call(method: string, path: string, tok: string, opts: { body?: unknown; stepUp?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
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

const T = '/plugins/toolchain';
type Fn = keyof typeof svc;
const READS: Array<[string, Fn]> = [
  [`${T}/releases`, 'listConsoleReleases'],
  [`${T}/releases/1.1.0/adoption`, 'getReleaseAdoption'],
  [`${T}/releases/1.1.0/canary`, 'getCanary'],
  [`${T}/releases/1.1.0/default-preview`, 'previewDefault'],
  [`${T}/history`, 'getDefaultHistory'],
  [`${T}/affected?release=1.1.0`, 'getAffected'],
  [`${T}/cleanup`, 'getCleanupCandidates'],
];
const WRITES: Array<[string, string, unknown, Fn]> = [
  ['PUT', `${T}/releases/1.1.0/rollout`, { orgIds: [TENANT] }, 'replaceRollout'],
  ['POST', `${T}/releases/1.1.0/default`, { expectedCurrentDefault: '1.0.0' }, 'promoteRelease'],
  ['PATCH', `${T}/releases/1.1.0`, { releaseNotes: 'n' }, 'setReleaseNotes'],
  ['POST', `${T}/releases/1.1.0/deprecate`, {}, 'deprecateConsoleRelease'],
  ['POST', `${T}/releases/1.1.0/yank`, { reason: 'synth crash' }, 'yankConsoleRelease'],
  ['DELETE', `${T}/releases/1.1.0`, undefined, 'deleteConsoleRelease'],
  ['POST', `${T}/affected/notify`, { releaseVersion: '1.1.0' }, 'notifyAffected'],
];

describe('reads: system org + toolchain:operate + aal2, never a step-up', () => {
  it.each(READS)('GET %s → 200 with no step-up token', async (path, fn) => {
    const res = await call('GET', path, token(OPERATOR));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(svc[fn]).toHaveBeenCalledTimes(1);
  });

  it('passes the contract shapes through (releases, preview, canary thresholds)', async () => {
    expect((await call('GET', `${T}/releases`, token(OPERATOR))).body.data).toEqual(RELEASES);
    expect((await call('GET', `${T}/releases/1.1.0/default-preview?n=2&m=1&t=10`, token(OPERATOR))).body.data.blastRadius)
      .toEqual({ followingPipelines: 3, followingOrgs: 2, orgsWithOwnDefault: 1, pinnedPipelines: 1 });
    expect(svc.previewDefault).toHaveBeenCalledWith('1.1.0', { n: 2, m: 1, t: 10 });
    await call('GET', `${T}/releases/1.1.0/canary?n=40`, token(OPERATOR));
    expect(svc.getCanary).toHaveBeenCalledWith('1.1.0', { n: 40 });
    await call('GET', `${T}/affected?release=1.1.0`, token(OPERATOR));
    expect(svc.getAffected).toHaveBeenCalledWith('1.1.0');
  });

  it('400 on a bad version, bad thresholds or a missing ?release', async () => {
    expect((await call('GET', `${T}/releases/1.1.0-dev/adoption`, token(OPERATOR))).status).toBe(400);
    expect((await call('GET', `${T}/releases/1.1.0/canary?n=0`, token(OPERATOR))).status).toBe(400);
    expect((await call('GET', `${T}/releases/1.1.0/canary?bogus=1`, token(OPERATOR))).status).toBe(400);
    expect((await call('GET', `${T}/affected`, token(OPERATOR))).status).toBe(400);
    expect(svc.getReleaseAdoption).not.toHaveBeenCalled();
  });
});

describe('writes: + requireStepUp, routed to the service with the caller as actor', () => {
  it.each(WRITES)('%s %s → 401 STEP_UP_REQUIRED without a step-up, 200 with one', async (method, path, body, fn) => {
    const denied = await call(method, path, token(OPERATOR), body === undefined ? {} : { body });
    expect([denied.status, denied.body.code]).toEqual([401, 'STEP_UP_REQUIRED']);
    expect(svc[fn]).not.toHaveBeenCalled();
    const ok = await call(method, path, token(OPERATOR), { ...(body === undefined ? {} : { body }), stepUp: stepUpToken() });
    expect([ok.status, ok.body.success]).toEqual([200, true]);
    expect(svc[fn]).toHaveBeenCalledTimes(1);
  });

  it('passes the bodies through and answers the contract shapes', async () => {
    const s = () => ({ stepUp: stepUpToken() });
    expect((await call('PUT', `${T}/releases/1.1.0/rollout`, token(OPERATOR), { body: { orgIds: [TENANT] }, ...s() })).body.data).toEqual(MEMBERS);
    expect(svc.replaceRollout).toHaveBeenCalledWith('1.1.0', [TENANT], 'u-op');

    const promoted = await call('POST', `${T}/releases/1.1.0/default`, token(OPERATOR), {
      body: { expectedCurrentDefault: '1.0.0', overrideReason: 'hotfix', canaryGate: { n: 5, m: 1, t: 2 } }, ...s(),
    });
    expect(promoted.body.data).toEqual({ platformDefault: '1.1.0' });
    expect(svc.promoteRelease).toHaveBeenCalledWith('1.1.0', { expectedCurrentDefault: '1.0.0', overrideReason: 'hotfix', canaryGate: { n: 5, m: 1, t: 2 } }, 'u-op');
    await call('POST', `${T}/releases/1.1.0/default`, token(OPERATOR), { body: { expectedCurrentDefault: null }, ...s() });
    expect(svc.promoteRelease).toHaveBeenLastCalledWith('1.1.0', { expectedCurrentDefault: null }, 'u-op');

    expect((await call('PATCH', `${T}/releases/1.1.0`, token(OPERATOR), { body: { releaseNotes: 'n' }, ...s() })).body.data).toEqual({ releaseVersion: '1.1.0', releaseNotes: 'n' });
    expect((await call('POST', `${T}/releases/1.1.0/deprecate`, token(OPERATOR), { body: { message: 'old' }, ...s() })).body.data).toEqual({});
    expect(svc.deprecateConsoleRelease).toHaveBeenCalledWith('1.1.0', 'u-op', 'old');
    expect((await call('POST', `${T}/releases/1.1.0/yank`, token(OPERATOR), { body: { reason: 'crash' }, ...s() })).body.data).toEqual({ restoredDefault: '1.0.0' });
    expect(svc.yankConsoleRelease).toHaveBeenCalledWith('1.1.0', 'crash', 'u-op');
    expect((await call('DELETE', `${T}/releases/1.1.0`, token(OPERATOR), s())).body.data).toEqual({});
    expect((await call('POST', `${T}/affected/notify`, token(OPERATOR), { body: { releaseVersion: '1.1.0' }, ...s() })).body.data).toEqual({ notifiedOrgs: 1, notifiedPipelines: 2 });
  });

  it('400 on invalid bodies (expectedCurrentDefault required, a yank reason, strict shapes)', async () => {
    const s = () => ({ stepUp: stepUpToken() });
    expect((await call('POST', `${T}/releases/1.1.0/default`, token(OPERATOR), { body: {}, ...s() })).status).toBe(400);
    expect((await call('POST', `${T}/releases/1.1.0/default`, token(OPERATOR), { body: { expectedCurrentDefault: '1.0.0', overrideReason: ' ' }, ...s() })).status).toBe(400);
    expect((await call('POST', `${T}/releases/1.1.0/yank`, token(OPERATOR), { body: {}, ...s() })).status).toBe(400);
    expect((await call('PUT', `${T}/releases/1.1.0/rollout`, token(OPERATOR), { body: { orgIds: 'x' }, ...s() })).status).toBe(400);
    expect((await call('PATCH', `${T}/releases/1.1.0`, token(OPERATOR), { body: { releaseNotes: 'n', extra: 1 }, ...s() })).status).toBe(400);
    expect((await call('POST', `${T}/affected/notify`, token(OPERATOR), { body: { releaseVersion: 'latest' }, ...s() })).status).toBe(400);
    expect(svc.promoteRelease).not.toHaveBeenCalled();
    expect(svc.yankConsoleRelease).not.toHaveBeenCalled();
  });

  it('service refusals pass through with their codes and details', async () => {
    svc.promoteRelease.mockRejectedValueOnce(new AppError(409, ErrorCode.TOOLCHAIN_GUARD_CANARY_GATE, 'not passed', { releaseVersion: '1.1.0', gate: { passed: false } }));
    const gate = await call('POST', `${T}/releases/1.1.0/default`, token(OPERATOR), { body: { expectedCurrentDefault: '1.0.0' }, stepUp: stepUpToken() });
    expect(gate.status).toBe(409);
    expect(gate.body).toMatchObject({ success: false, code: 'TOOLCHAIN_GUARD_CANARY_GATE', details: { gate: { passed: false } } });

    svc.yankConsoleRelease.mockRejectedValueOnce(new AppError(409, ErrorCode.TOOLCHAIN_DEFAULT_REQUIRED, 'set another default first'));
    expect((await call('POST', `${T}/releases/1.0.0/yank`, token(OPERATOR), { body: { reason: 'x' }, stepUp: stepUpToken() })).body)
      .toMatchObject({ code: 'TOOLCHAIN_DEFAULT_REQUIRED' });

    svc.deleteConsoleRelease.mockRejectedValueOnce(new AppError(409, ErrorCode.PLUGIN_VERSION_IN_USE, 'in use', { pinnedPipelines: 2 }));
    expect((await call('DELETE', `${T}/releases/1.0.0`, token(OPERATOR), { stepUp: stepUpToken() })).body)
      .toMatchObject({ code: 'PLUGIN_VERSION_IN_USE', details: { pinnedPipelines: 2 } });
  });
});

describe('who is refused (every console route)', () => {
  const every = [
    ...READS.map(([path]) => ['GET', path, undefined] as const),
    ...WRITES.map(([method, path, body]) => [method, path, body] as const),
  ];

  it.each([
    ['a tenant Admin (every org-assignable permission, plus toolchain:operate on the token)', () => token([...ROLE_PERMISSIONS.admin, 'toolchain:operate'], { org: TENANT }), 403],
    ['a system-org toolchain:manage holder', () => token(['toolchain:manage', 'pipelines:read']), 403],
    // A weak session is told to re-authenticate (the assurance gate's 401), never served.
    ['a system-org toolchain:operate holder on an aal1 session', () => token(OPERATOR, { aal: 1 }), 401],
  ] as const)('refused for %s, with a step-up, on every route', async (_who, tok, status) => {
    for (const [method, path, body] of every) {
      const res = await call(method, path, tok(), { ...(body === undefined ? {} : { body }), stepUp: stepUpToken() });
      expect([method, path, res.status]).toEqual([method, path, status]);
    }
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled();
  });

  it('a tenant Admin is refused as SYSTEM_ORG_REQUIRED', async () => {
    const res = await call('GET', `${T}/releases`, token([...ROLE_PERMISSIONS.admin, 'toolchain:operate'], { org: TENANT }));
    expect(res.body).toMatchObject({ code: 'SYSTEM_ORG_REQUIRED' });
  });
});
