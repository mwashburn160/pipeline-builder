// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The retention routes' GATES over the REAL app (createApp, mountRoutes,
 * api-core's verifiers, requireSystemOrgPermission and requireStepUp, real
 * ES256 user and step-up tokens). The pass itself is replaced — what it does is
 * retention-pass.test.ts.
 *
 *  - both routes: system org + `plugins:moderate` + aal2;
 *  - the dry run never steps up; the run needs a step-up.
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

process.env.JWT_SECRET ||= 'retention-routes-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-retention-routes-'));
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

const REPORT = { generatedAt: '2026-11-14T00:00:00.000Z', dryRun: true, plugins: [], collected: [], totals: { retirable: 0 } };
const runRetentionPass = jest.fn<AnyFn>(async (opts: { dryRun: boolean }) => ({ ...REPORT, dryRun: opts.dryRun }));
jest.unstable_mockModule('../src/services/retention/retire.js', () => ({ runRetentionPass }));

const { ROLE_PERMISSIONS, SYSTEM_ORG_ID, createQuotaService } = await import('@pipeline-builder/api-core');
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
beforeEach(() => { runRetentionPass.mockClear(); });

const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const token = (permissions: readonly string[], opts: { org?: string; aal?: number } = {}) => signTestUserToken({
  ...testUserIdentityClaims(),
  sub: 'u-mod',
  role: 'member',
  organizationId: opts.org ?? SYSTEM_ORG_ID,
  permissions: [...permissions],
  aal: opts.aal ?? 2,
  amr: ['pwd', 'mfa'],
}, { key: userKey });
const stepUpToken = () => signTestUserToken({ type: 'step-up', sub: 'u-mod', jti: randomUUID() }, { key: userKey, expiresIn: 60 });
const MODERATOR = ['plugins:moderate'];

async function call(method: string, path: string, tok: string, stepUp?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...(stepUp ? { 'x-step-up-token': stepUp } : {}) } });
  return { status: res.status, body: await res.json() };
}

describe('GET /plugins/retention/plan', () => {
  it('answers the dry run to a system-org plugins:moderate holder on an aal2 session, with no step-up', async () => {
    const res = await call('GET', '/plugins/retention/plan', token(MODERATOR));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dryRun: true, totals: { retirable: 0 } });
    expect(runRetentionPass).toHaveBeenCalledWith({ dryRun: true });
  });

  it.each([
    ['a tenant Admin, even one whose token claims plugins:moderate', token([...ROLE_PERMISSIONS.admin, 'plugins:moderate'], { org: TENANT })],
    ['a system-org member without plugins:moderate', token(['plugins:read', 'plugins:write'])],
    ['an aal1 session (401: re-authenticate with MFA)', token(MODERATOR, { aal: 1 }), 401],
  ].map(([l, t, s]) => [l as string, t as string, (s ?? 403) as number] as const))('refuses %s', async (_label, tok, status) => {
    expect((await call('GET', '/plugins/retention/plan', tok)).status).toBe(status);
    expect(runRetentionPass).not.toHaveBeenCalled();
  });
});

describe('POST /plugins/retention/run', () => {
  it('needs a step-up, then runs one pass and answers its report', async () => {
    const denied = await call('POST', '/plugins/retention/run', token(MODERATOR));
    expect([denied.status, denied.body.code]).toEqual([401, 'STEP_UP_REQUIRED']);
    expect(runRetentionPass).not.toHaveBeenCalled();
    const ok = await call('POST', '/plugins/retention/run', token(MODERATOR), stepUpToken());
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ dryRun: false });
    expect(runRetentionPass).toHaveBeenCalledWith({ dryRun: false });
  });

  it('refuses a tenant org and an aal1 session before the step-up', async () => {
    expect((await call('POST', '/plugins/retention/run', token(MODERATOR, { org: TENANT }), stepUpToken())).status).toBe(403);
    expect((await call('POST', '/plugins/retention/run', token(MODERATOR, { aal: 1 }), stepUpToken())).status).toBe(401);
    expect(runRetentionPass).not.toHaveBeenCalled();
  });
});
