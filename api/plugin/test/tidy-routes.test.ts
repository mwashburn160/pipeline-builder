// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The automatic tidying routes' GATES and bodies over the REAL app
 * (createApp, mountRoutes, api-core's verifiers, real ES256 user tokens). The
 * job and the writes are replaced — what they do is tidy-pass.test.ts.
 *
 *  - GET  /plugins/tidy/preview                 plugins:read
 *  - PUT  /plugins/tidy/settings                org_settings:write
 *  - POST /plugins/tidy/versions/:id/keep       plugins:write
 *  - PUT  /plugins/by-name/:name/never-tidy     plugins:write
 */

import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  type AnyFn, bindTestAuditService, generateTestSigningKey, installTestJwks, signTestUserToken, testUserIdentityClaims,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'tidy-routes-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-tidy-routes-'));
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

const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const PLUGIN_ID = '11111111-1111-4111-8111-111111111111';
const SETTINGS = { autoTidy: 'notify', staleAfterDays: 90, neverTidy: [], lastDigestAt: null };
const tidyPreview = jest.fn<AnyFn>(async (orgId: string) => ({ orgId, dryRun: true, mode: 'notify', versions: [], totals: { warn: 0, bytesFreed: null } }));
jest.unstable_mockModule('../src/services/tidy/pass.js', () => ({ tidyPreview, createTidyScheduler: jest.fn() }));
const readTidySettings = jest.fn<AnyFn>(async () => SETTINGS);
const writeTidySettings = jest.fn<AnyFn>(async (_o: string, patch: object) => ({ ...SETTINGS, ...patch }));
const keepVersion = jest.fn<AnyFn>(async (_o: string, id: string) => ({ id, name: 'lint', version: '1.0.0', isActive: true, tidyKeptAt: new Date() }));
const setNeverTidy = jest.fn<AnyFn>(async (_o: string, name: string, never: boolean) => ({ ...SETTINGS, neverTidy: never ? [name] : [] }));
const recordPluginUse = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/tidy/usage.js', () => ({ keepVersion, setNeverTidy, recordPluginUse, clockRestartSet: () => ({}) }));
const actualSettings = await import('../src/services/tidy/settings.js');
jest.unstable_mockModule('../src/services/tidy/settings.js', () => ({ ...actualSettings, readTidySettings, writeTidySettings }));

const { createQuotaService } = await import('@pipeline-builder/api-core');
const { createApp, attachRequestContext } = await import('@pipeline-builder/api-server');
const { mountRoutes } = await import('../src/app-routes.js');

const audit = bindTestAuditService();
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
beforeEach(() => { jest.clearAllMocks(); });

const token = (permissions: readonly string[]) => signTestUserToken({
  ...testUserIdentityClaims(),
  sub: 'u-1',
  role: 'member',
  organizationId: TENANT,
  permissions: [...permissions],
}, { key: userKey });

async function call(method: string, path: string, tok: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

describe('GET /plugins/tidy/preview', () => {
  it('answers the org\'s dry run, its settings and what the caller may change', async () => {
    const res = await call('GET', '/plugins/tidy/preview', token(['plugins:read']));
    expect(res.status).toBe(200);
    expect(tidyPreview).toHaveBeenCalledWith(TENANT);
    expect(res.body.data).toMatchObject({ settings: SETTINGS, report: { orgId: TENANT, dryRun: true }, canEdit: false, canKeep: false });
    const writer = await call('GET', '/plugins/tidy/preview', token(['plugins:read', 'plugins:write', 'org_settings:write']));
    expect(writer.body.data).toMatchObject({ canEdit: true, canKeep: true });
  });

  it('refuses a caller without plugins:read', async () => {
    expect((await call('GET', '/plugins/tidy/preview', token(['pipelines:read']))).status).toBe(403);
    expect(tidyPreview).not.toHaveBeenCalled();
  });
});

describe('PUT /plugins/tidy/settings', () => {
  it('saves the mode and the days for an org_settings:write holder, audited', async () => {
    const res = await call('PUT', '/plugins/tidy/settings', token(['org_settings:write']), { autoTidy: 'on', staleAfterDays: 45 });
    expect(res.status).toBe(200);
    expect(writeTidySettings).toHaveBeenCalledWith(TENANT, { autoTidy: 'on', staleAfterDays: 45 }, 'u-1');
    expect(res.body.data.settings).toMatchObject({ autoTidy: 'on', staleAfterDays: 45 });
    expect(audit.mock.calls.map((c) => (c[0] as any).action)).toContain('plugin.tidy.settings.update');
  });

  it.each([
    [{ staleAfterDays: 29 }],
    [{ autoTidy: 'always' }],
    [{}],
    [{ neverTidy: ['x'] }],
  ])('refuses %j (400)', async (body) => {
    expect((await call('PUT', '/plugins/tidy/settings', token(['org_settings:write']), body)).status).toBe(400);
    expect(writeTidySettings).not.toHaveBeenCalled();
  });

  it('refuses a plugins:write holder without org_settings:write', async () => {
    expect((await call('PUT', '/plugins/tidy/settings', token(['plugins:write', 'plugins:read']), { autoTidy: 'off' })).status).toBe(403);
  });
});

describe('POST /plugins/tidy/versions/:id/keep', () => {
  it('keeps one of the org\'s versions for a plugins:write holder', async () => {
    const res = await call('POST', `/plugins/tidy/versions/${PLUGIN_ID}/keep`, token(['plugins:write']));
    expect(res.status).toBe(200);
    expect(keepVersion).toHaveBeenCalledWith(TENANT, PLUGIN_ID, 'u-1');
    expect(res.body.data.plugin).toMatchObject({ id: PLUGIN_ID, isActive: true });
  });

  it('404s another org\'s (or a missing) version, 400s a malformed id, 403s without plugins:write', async () => {
    keepVersion.mockResolvedValueOnce(null);
    expect((await call('POST', `/plugins/tidy/versions/${PLUGIN_ID}/keep`, token(['plugins:write']))).status).toBe(404);
    expect((await call('POST', '/plugins/tidy/versions/nope/keep', token(['plugins:write']))).status).toBe(400);
    expect((await call('POST', `/plugins/tidy/versions/${PLUGIN_ID}/keep`, token(['plugins:read']))).status).toBe(403);
  });
});

describe('PUT /plugins/by-name/:name/never-tidy', () => {
  it('sets and clears a plugin\'s never-tidy for a plugins:write holder', async () => {
    const on = await call('PUT', '/plugins/by-name/lint/never-tidy', token(['plugins:write']), { neverTidy: true });
    expect(on.status).toBe(200);
    expect(setNeverTidy).toHaveBeenCalledWith(TENANT, 'lint', true, 'u-1');
    expect(on.body.data).toMatchObject({ name: 'lint', neverTidy: true });
    expect((await call('PUT', '/plugins/by-name/lint/never-tidy', token(['plugins:write']), { neverTidy: 'yes' })).status).toBe(400);
    expect((await call('PUT', '/plugins/by-name/lint/never-tidy', token(['plugins:read']), { neverTidy: true })).status).toBe(403);
  });
});
