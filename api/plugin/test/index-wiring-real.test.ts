// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end wiring test for src/index.ts — the REAL mount order over the REAL
 * middleware.
 *
 * Runs the real boot module with the real api-core gates (`requireAuth`,
 * `requirePermission`, `requireFeature`, `requireStepUp`, `loadAndPurge` /
 * `loadAndRestore`, the quota + compliance HTTP clients) and the real api-server
 * request middleware (auth/org/idempotency/tenant chain, `checkQuota`,
 * `withRoute`, `rateLimitByOrg`), and the real route routers. Only INFRA is
 * replaced: the Postgres-backed plugin service, the BullMQ/Redis build queue,
 * object storage, the audit client, the AI provider, and the process bootstrap
 * (`createApp`'s helmet/CORS/Redis stores + `runServer`). The quota and
 * compliance services are a local HTTP stub the real clients talk to.
 *
 * Regressions locked in (each failed against the previous stacked-chain mounts):
 *  - purge and restore each succeed with ONE step-up token (a separate step-up
 *    mount per router consumed the single-use jti twice → STEP_UP_REPLAY);
 *  - bulk works without a step-up token (it sat behind both step-up mounts →
 *    STEP_UP_REQUIRED);
 *  - `POST /plugins/deploy-generated` with an Idempotency-Key is not 409'd (the
 *    request passed the idempotency middleware once per stacked chain, and the
 *    second pass saw the first pass's pending reservation).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import {
  type AnyFn,
  bindTestAuditService,
  generateTestSigningKey,
  installTestJwks,
  signTestUserToken,
  type TestSigningKey,
  stubModule,
} from '@pipeline-builder/api-core/testing';
import express from 'express';
import jwt from 'jsonwebtoken';

// -- Environment (read at module load by the real clients/config) -------------

const JWT_SECRET = 'index-wiring-real-test-secret-0123456789';

/**
 * Platform's ES256 signing key, published through the JWKS installed here. User
 * and step-up tokens are asymmetric since, so the shared `JWT_SECRET` this
 * service holds cannot mint one — asserted in the negative case below.
 */
const signingKey: TestSigningKey = generateTestSigningKey();
installTestJwks([signingKey]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-wiring-'));
process.env.JWT_SECRET = JWT_SECRET;
process.env.SOFT_DELETE_PURGE_ENABLED = 'false';
process.env.PLUGIN_UPLOAD_DIR = scratch;
process.env.DOCKER_BUILD_TEMP_ROOT = scratch;
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

// -- Quota + compliance service stub (spoken to by the REAL HTTP clients) ------

const stubCalls: string[] = [];
const stub = http.createServer((req, res) => {
  stubCalls.push(`${req.method} ${req.url}`);
  req.resume();
  req.on('end', () => {
    const url = req.url ?? '';
    const send = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const quota = { type: 'plugins', limit: 100, used: 1, remaining: 99, resetAt: '2026-09-30T00:00:00.000Z' };
    if (url.startsWith('/compliance/validate/')) return send({ success: true, data: { blocked: false, violations: [], warnings: [] } });
    if (req.method === 'POST' && /\/quotas\/[^/]+\/(increment|decrement)$/.test(url)) return send({ success: true, data: { quota } });
    if (req.method === 'GET' && /^\/quotas\/[^/]+\/[^/]+$/.test(url)) {
      return send({ success: true, data: { status: { allowed: true, limit: -1, used: 0, remaining: -1, resetAt: quota.resetAt, unlimited: true } } });
    }
    if (req.method === 'GET' && /^\/quotas\/[^/]+$/.test(url)) return send({ success: true, data: { quota: { tier: 'developer' } } });
    res.writeHead(404); res.end('{}');
  });
});
await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const stubPort = (stub.address() as { port: number }).port;
process.env.QUOTA_SERVICE_HOST = '127.0.0.1';
process.env.QUOTA_SERVICE_PORT = String(stubPort);
process.env.COMPLIANCE_SERVICE_HOST = '127.0.0.1';
process.env.COMPLIANCE_SERVICE_PORT = String(stubPort);

// -- api-server: the REAL request middleware, minus process bootstrap ---------
//
// Loaded from the package's own modules (not its mocked entry point), so the
// auth/org/idempotency/tenant chain, checkQuota, withRoute and rateLimitByOrg
// are the production implementations.

const API_SERVER = '@pipeline-builder/api-server/lib/api';
const realServer = {
  ...(await import(`${API_SERVER}/middleware-factory.js`)),
  ...(await import(`${API_SERVER}/check-quota.js`)),
  ...(await import(`${API_SERVER}/idempotency-middleware.js`)),
  ...(await import(`${API_SERVER}/context-middleware.js`)),
  ...(await import(`${API_SERVER}/require-org-id.js`)),
  ...(await import(`${API_SERVER}/tenant-context.js`)),
  ...(await import(`${API_SERVER}/route-wrapper.js`)),
  ...(await import(`${API_SERVER}/rate-limit-by-org.js`)),
  ...(await import(`${API_SERVER}/meter-quota.js`)),
  ...(await import(`${API_SERVER}/quota-reservation.js`)),
  ...(await import(`${API_SERVER}/metrics.js`)),
};

const app = express();
app.use(express.json());
const sseManager = { bindStreamOwner: jest.fn(async () => undefined), send: jest.fn<AnyFn>() };

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  ...realServer,
  createApp: () => ({ app, sseManager }),
  runServer: jest.fn<AnyFn>(),
  postgresHealthCheck: jest.fn<AnyFn>(),
  redisHealthCheck: jest.fn<AnyFn>(),
  combineHealthChecks: jest.fn<AnyFn>(),
}, { extraOverrides: 'drop' })); // assembled from api-server's internal files, which carry non-barrel exports

// -- Infra doubles ------------------------------------------------------------

const mockEnqueueBuild = jest.fn(async () => undefined);
jest.unstable_mockModule('../src/queue/plugin-build-queue.js', () => ({
  startWorker: jest.fn<AnyFn>(),
  waitForWorkerReady: jest.fn(async () => undefined),
  shutdownQueue: jest.fn(async () => undefined),
}));
// The anonymous-submission gate queue — index.ts starts its worker at boot.
jest.unstable_mockModule('../src/queue/submission-build-queue.js', () => ({
  startSubmissionWorker: jest.fn<AnyFn>(),
  shutdownSubmissionQueue: jest.fn(async () => undefined),
  enqueueSubmissionBuild: jest.fn(async () => undefined),
}));
// The nightly vuln-rescan scheduler — index.ts builds + starts it at boot.
const mockRescanScheduler = { start: jest.fn<AnyFn>(), stop: jest.fn<AnyFn>() };
jest.unstable_mockModule('../src/queue/vuln-rescan.js', () => ({ createVulnRescanScheduler: () => mockRescanScheduler }));
// The ecosystem-notification digest dispatcher — index.ts builds + starts it at boot.
jest.unstable_mockModule('../src/services/ecosystem-notifications.js', () => ({
  createEcosystemNotificationScheduler: () => ({ start: () => undefined, stop: () => undefined }),
  enqueueEcosystemNotification: async () => 'sent',
}));
jest.unstable_mockModule('../src/queue/connections.js', () => ({
  getHealthRedisConnection: () => ({ get: async () => null }),
  enqueueBuild: mockEnqueueBuild,
  getOrgTier: async () => 'developer',
  getAllTierQueues: () => [],
  getDeadLetterQueue: () => ({ getJob: async () => null, getJobs: async () => [], getJobCounts: async () => ({}) }),
  findFailedJob: async () => null,
  dlqJobId: (q: string, id: string) => `dlq-${q}:${id}`,
  getTierQueue: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({ purgeDlq: jest.fn(async () => 0) }));
// Plugin-ecosystem upkeep scheduler + the boot-time Official-publisher assertion.
const mockMaintenanceScheduler = { start: jest.fn<AnyFn>(), stop: jest.fn<AnyFn>() };
jest.unstable_mockModule('../src/services/ecosystem/maintenance.js', () => ({
  createEcosystemMaintenanceScheduler: () => mockMaintenanceScheduler,
}));
// The ecosystem gauge sampler — index.ts builds + starts it at boot.
jest.unstable_mockModule('../src/services/ecosystem/metrics.js', () => ({
  createEcosystemMetricsScheduler: () => ({ start: () => undefined, stop: () => undefined }),
  recordDecision: () => undefined,
  recordSubmission: () => undefined,
  recordSubmissionGateFailures: () => undefined,
}));
// The plugin_stats sweep — index.ts builds + starts it at boot.
jest.unstable_mockModule('../src/services/ecosystem/stats.js', () => ({
  createEcosystemStatsScheduler: () => ({ start: () => undefined, stop: () => undefined }),
  refreshListingRating: async () => undefined,
}));

const tombstone = { id: '', orgId: 'org-1', name: 'p', version: '1.0.0', visibility: 'org', createdBy: 'user-1', keywords: [], installCommands: [], commands: [] };
const pluginService = {
  findDeletedById: jest.fn(async (id: string) => ({ ...tombstone, id })),
  restore: jest.fn(async (id: string, ..._rest: unknown[]) => ({ ...tombstone, id })),
  purgeById: jest.fn(async (id: string, ..._rest: unknown[]) => id),
  bulkDelete: jest.fn(async (ids: string[], ..._rest: unknown[]) => ids.map((id) => ({ id }))),
  findById: jest.fn(async (id: string) => ({ ...tombstone, id })),
  update: jest.fn(async (id: string) => ({ ...tombstone, id })),
  assertDeployable: jest.fn(async () => undefined),
  purgeExpired: jest.fn<AnyFn>(),
  // delete safety + immutability checks the write routes run.
  findByIds: jest.fn(async (ids: string[]) => ids.map((id) => ({ ...tombstone, id }))),
  deleteBlockers: jest.fn(async () => ({ frozen: false, listed: false, inUse: 0 })),
  versionImmutability: jest.fn(async () => null),
  clearQuotaSnapshot: jest.fn(async () => undefined),
  promoteNextDefault: jest.fn(async () => null),
};
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService }));
jest.unstable_mockModule('../src/services/plugin-artifact-storage.js', () => ({
  putPluginArtifact: jest.fn(async () => undefined),
  deletePluginArtifact: jest.fn(async () => undefined),
  getPluginArtifactToFile: jest.fn<AnyFn>(),
  pluginArtifactKey: (orgId: string, requestId: string) => `${orgId}/${requestId}.zip`,
  pluginQuarantineBucket: () => 'plugin-quarantine',
  submissionArtifactKey: (id: string) => `submissions/${id}.zip`,
}));
jest.unstable_mockModule('../src/services/ai-plugin-generation-service.js', () => ({
  AIEmptyOutputError: class extends Error {},
  dockerfileViolations: () => [],
  getAvailableProviders: () => [],
  generatePluginConfig: jest.fn<AnyFn>(),
  streamPluginConfig: jest.fn<AnyFn>(),
}));

await import('../src/index.js');
// Boot bound the real 'plugin' audit client; rebind to a spy so audited routes
// deliver nothing (no platform POST, no env-Redis spool).
bindTestAuditService('plugin');
// Captured at boot: the suite's clearMocks would reset it before any test runs.
const rescanStartsAtBoot = mockRescanScheduler.start.mock.calls.length;
const maintenanceStartsAtBoot = mockMaintenanceScheduler.start.mock.calls.length;

const server = await new Promise<http.Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

// -- Helpers ------------------------------------------------------------------

function accessToken(claims: Record<string, unknown> = {}): string {
  return signTestUserToken({
    type: 'access',
    sub: 'user-1',
    role: 'member',
    organizationId: 'org-1',
    permissions: ['plugins:write'],
    features: ['bulk_operations'],
    // Identity claims `requireAuth` now insists on (fail-closed): a known
    // principalType + token_use, plus the auth-method/assurance trio a user
    // principal must carry.
    principalType: 'user',
    token_use: 'access',
    amr: ['pwd'],
    aal: 1,
    auth_time: Math.floor(Date.now() / 1000),
    ...claims,
  }, { key: signingKey, expiresIn: 300 });
}

function stepUpToken(sub = 'user-1'): string {
  return signTestUserToken({ type: 'step-up', sub, jti: randomUUID() }, { key: signingKey, expiresIn: 60 });
}

/**
 * An HS256 token, shaped like a real access token and signed with the shared
 * `JWT_SECRET` this service holds. Before it was indistinguishable from a
 * platform mint; now every verifier refuses it. Used by the negative case below.
 */
function forgedHs256AccessToken(): string {
  return jwt.sign({
    type: 'access',
    sub: 'user-1',
    role: 'owner',
    organizationId: 'org-1',
    permissions: ['plugins:write'],
    features: ['bulk_operations'],
    isSuperAdmin: true,
    principalType: 'user',
    token_use: 'access',
    amr: ['pwd'],
    aal: 1,
    auth_time: Math.floor(Date.now() / 1000),
  }, JWT_SECRET, { algorithm: 'HS256', expiresIn: 300 });
}

async function call(method: string, urlPath: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${accessToken()}`, ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  stubCalls.length = 0;
});

// -- Tests --------------------------------------------------------------------

describe('boot', () => {
  it('starts the nightly vulnerability rescan scheduler', () => {
    expect(rescanStartsAtBoot).toBe(1);
  });

  it('starts the plugin-ecosystem maintenance scheduler', () => {
    expect(maintenanceStartsAtBoot).toBe(1);
  });
});

describe('step-up gated routes share ONE step-up layer', () => {
  it('purge succeeds with a single step-up token', async () => {
    const res = await call('POST', `/plugins/${ID_A}/purge`, { headers: { 'x-step-up-token': stepUpToken() } });

    expect(res.json?.code ?? res.json?.errorCode).not.toBe('STEP_UP_REPLAY');
    expect(res.status).toBe(200);
    expect(pluginService.purgeById).toHaveBeenCalledWith(ID_A, 'org-1');
  });

  it('restore succeeds with a single step-up token', async () => {
    const res = await call('POST', `/plugins/${ID_B}/restore`, { headers: { 'x-step-up-token': stepUpToken() } });

    expect(res.status).toBe(200);
    expect(pluginService.restore).toHaveBeenCalledWith(ID_B, 'org-1', 'user-1');
  });

  it('still enforces step-up: no token → 401, a replayed token → 401', async () => {
    expect((await call('POST', `/plugins/${ID_A}/purge`)).status).toBe(401);

    const token = stepUpToken();
    expect((await call('POST', `/plugins/${ID_A}/restore`, { headers: { 'x-step-up-token': token } })).status).toBe(200);
    const replay = await call('POST', `/plugins/${ID_A}/purge`, { headers: { 'x-step-up-token': token } });
    expect(replay.status).toBe(401);
    expect(pluginService.purgeById).not.toHaveBeenCalled();
  });

  it('REJECTS an HS256 token that claims to be a user, through the real chain', async () => {
    // This service holds `JWT_SECRET` (it mints service tokens with it to push
    // plugin images), so before it could forge a platform-admin session for
    // itself. The forged token below carries owner + isSuperAdmin and still 401s.
    const res = await call('POST', '/plugins/p-1/purge', {
      headers: { 'authorization': `Bearer ${forgedHs256AccessToken()}`, 'x-step-up-token': stepUpToken() },
    });
    expect(res.status).toBe(401);
  });

  it('purge/restore still require plugins:write', async () => {
    const res = await call('POST', `/plugins/${ID_A}/purge`, {
      headers: { 'authorization': `Bearer ${accessToken({ permissions: [] })}`, 'x-step-up-token': stepUpToken() },
    });
    expect(res.status).toBe(403);
    expect(pluginService.purgeById).not.toHaveBeenCalled();
  });
});

describe('bulk routes', () => {
  it('bulk delete works WITHOUT a step-up token', async () => {
    const res = await call('POST', '/plugins/bulk/delete', { body: { ids: [ID_A, ID_B] } });

    expect(res.status).toBe(200);
    expect(pluginService.bulkDelete).toHaveBeenCalledWith([ID_A, ID_B], 'org-1', 'user-1', { isSystemAdmin: false, canPublish: false });
  });

  it('bulk still requires the bulk_operations feature and plugins:write', async () => {
    const noFeature = await call('POST', '/plugins/bulk/delete', {
      headers: { authorization: `Bearer ${accessToken({ features: [] })}` },
      body: { ids: [ID_A] },
    });
    expect(noFeature.status).toBe(403);

    const noWrite = await call('POST', '/plugins/bulk/delete', {
      headers: { authorization: `Bearer ${accessToken({ permissions: [] })}` },
      body: { ids: [ID_A] },
    });
    expect(noWrite.status).toBe(403);
    expect(pluginService.bulkDelete).not.toHaveBeenCalled();
  });

  it('the bulk_operations gate does not leak onto purge/restore', async () => {
    const res = await call('POST', `/plugins/${ID_A}/restore`, {
      headers: { 'authorization': `Bearer ${accessToken({ features: [] })}`, 'x-step-up-token': stepUpToken() },
    });
    expect(res.status).toBe(200);
  });

  it('write routes keep the apiCalls quota check they inherit from the read mount', async () => {
    await call('POST', '/plugins/bulk/delete', { body: { ids: [ID_A] } });
    expect(stubCalls).toContain('GET /quotas/org-1/apiCalls');
  });
});

describe('each request passes the idempotency middleware exactly once', () => {
  const deployBody = {
    name: 'gen-plugin',
    version: '1.0.0',
    commands: ['echo hi'],
    dockerfile: 'FROM alpine:3.20',
  };

  it('POST /plugins/deploy-generated with an Idempotency-Key is accepted (202), not 409', async () => {
    const res = await call('POST', '/plugins/deploy-generated', {
      headers: { 'idempotency-key': `key-${randomUUID()}` },
      body: deployBody,
    });

    expect(res.status).toBe(202);
    expect(mockEnqueueBuild).toHaveBeenCalledTimes(1);
  });

  it('a retry with the same key replays the original response instead of re-running or 409-ing', async () => {
    const key = `key-${randomUUID()}`;
    const first = await call('POST', '/plugins/deploy-generated', { headers: { 'idempotency-key': key }, body: deployBody });
    const retry = await call('POST', '/plugins/deploy-generated', { headers: { 'idempotency-key': key }, body: deployBody });

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.headers.get('x-idempotent-replayed')).toBe('true');
    expect(mockEnqueueBuild).toHaveBeenCalledTimes(1);
  });

  it('PUT /plugins/:id (behind the read + write mounts) with an Idempotency-Key is not 409', async () => {
    const res = await call('PUT', `/plugins/${ID_A}`, {
      headers: { 'idempotency-key': `key-${randomUUID()}` },
      body: { description: 'updated' },
    });

    expect(res.status).toBe(200);
    expect(pluginService.update).toHaveBeenCalledTimes(1);
  });
});
