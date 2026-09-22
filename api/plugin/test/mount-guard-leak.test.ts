// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral regression lock-in for the "mount-guard leak" fix (plugin service).
 *
 * `requireFeature('ai_generation')` used to be attached to the shared
 * `app.use('/plugins', ...guards, generateRouter)` mount, so it ran for ANY
 * request under `/plugins` — including a plain `GET /plugins` read, which 403'd
 * a user without the ai_generation feature.
 *
 * This suite imports the REAL src/index.ts wiring (the actual line-69 generate
 * mount) with a real Express app. The generate router is REAL (so it carries its
 * own per-route feature guard); the heavier sibling factories are stubbed, with
 * a stand-in read route standing in for `GET /plugins`. It proves:
 *   1. a user WITHOUT ai_generation can still `GET /plugins`;
 *   2. the generate routes STILL enforce ai_generation (403 without, pass with).
 */

import http from 'node:http';

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import express, { Router } from 'express';
import { apiCoreMock } from './helpers/mock-api-core.js';

const capturedApp = express();
capturedApp.use(express.json());

const featureGuard = (feature: string) => (req: any, res: any, next: () => void) => {
  if (!req.user) return res.status(401).json({ message: 'unauthenticated' });
  if (req.user.isSuperAdmin) return next();
  return req.user.features?.includes(feature)
    ? next()
    : res.status(403).json({ message: `feature required: ${feature}` });
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({ increment: jest.fn(), check: jest.fn(), getUsage: jest.fn() }),
  createRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
  registerComplianceEventSubscriber: jest.fn(),
  requireFeature: (feature: string) => featureGuard(feature),
  decrementQuota: jest.fn(),
  // generate-plugin.ts mints a service token for the quota reserve/decrement calls.
  getServiceAuthHeader: () => 'Bearer test-service-token',
  reserveQuota: async () => ({ exceeded: false, quota: { type: 'aiCalls', limit: 1, used: 0, remaining: 1, resetAt: 0 } }),
  handleAIError: (res: any, msg: string) => res.status(500).json({ message: msg }),
  initSSEStream: () => ({ aborted: () => false }),
  // Fail body validation AFTER the gate so an allowed generate lands a 400
  // (not 403) — proving the feature gate let it through.
  validateBody: () => ({ ok: false, error: 'stub-invalid-body' }),
  sendSuccess: (res: any, statusCode: number, data?: any) => res.status(statusCode).json({ success: true, statusCode, data }),
  sendBadRequest: (res: any, msg: string) => res.status(400).json({ success: false, statusCode: 400, message: msg }),
  sendQuotaReserveDenied: (res: any) => res.status(429).json({ success: false, statusCode: 429 }),
  AIGenerateBodySchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: jest.fn(),
  setGauge: jest.fn(),
  observe: jest.fn(),
  rateLimitByOrg: () => (_req: any, _res: any, next: () => void) => next(),
  createApp: () => ({ app: capturedApp, sseManager: {} }),
  runServer: jest.fn(),
  postgresHealthCheck: () => async () => ({ ok: true }),
  redisHealthCheck: () => async () => ({ ok: true }),
  combineHealthChecks: (...fns: unknown[]) => fns,
  checkQuota: () => (_req: any, _res: any, next: () => void) => next(),
  createAuthenticatedWithOrgRoute: () => [(_req: any, _res: any, next: () => void) => next()],
  attachRequestContext: () => (req: any, _res: any, next: () => void) => {
    const list = (h: unknown) => (typeof h === 'string' && h ? h.split(',') : []);
    const orgId = (req.headers['x-org-id'] as string) || 'acme';
    req.user = {
      orgId,
      role: 'member',
      isSuperAdmin: req.headers['x-test-superadmin'] === 'true',
      features: list(req.headers['x-test-features']),
      capabilities: list(req.headers['x-test-caps']),
    };
    req.context = { identity: { orgId, userId: 'user-1' }, log: jest.fn(), requestId: 'req-1' };
    next();
  },
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId;
    if (opts?.requireOrgId !== false && !orgId) {
      return res.status(400).json({ message: 'Organization ID is required' });
    }
    try {
      await handler({ req, res, ctx, orgId, userId: ctx.identity.userId });
    } catch (err: any) {
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  },
  meterQuotaOnSuccess: (_qs: unknown, quotaType: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { meters: quotaType }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { SSE_STREAM_TIMEOUT_MS: 1000, MAX_BULK_ITEMS: 100 },
}));

jest.unstable_mockModule('../src/queue/plugin-build-queue.js', () => ({
  startWorker: jest.fn(),
  waitForWorkerReady: jest.fn(async () => undefined),
  shutdownQueue: jest.fn(async () => undefined),
}));
// The anonymous-submission gate queue — index.ts starts its worker at boot.
jest.unstable_mockModule('../src/queue/submission-build-queue.js', () => ({
  startSubmissionWorker: jest.fn(),
  shutdownSubmissionQueue: jest.fn(async () => undefined),
  enqueueSubmissionBuild: jest.fn(async () => undefined),
}));
// The nightly vuln-rescan scheduler — index.ts builds + starts it at boot.
jest.unstable_mockModule('../src/queue/vuln-rescan.js', () => ({ createVulnRescanScheduler: () => null }));
// The ecosystem-notification digest dispatcher — index.ts builds + starts it at boot.
jest.unstable_mockModule('../src/services/ecosystem-notifications.js', () => ({
  createEcosystemNotificationScheduler: () => ({ start: () => undefined, stop: () => undefined }),
  enqueueEcosystemNotification: async () => 'sent',
}));
jest.unstable_mockModule('../src/queue/connections.js', () => ({ getHealthRedisConnection: jest.fn() }));

jest.unstable_mockModule('../src/services/ai-plugin-generation-service.js', () => ({
  AIEmptyOutputError: class extends Error {},
  dockerfileViolations: () => [],
  getAvailableProviders: jest.fn(() => []),
  generatePluginConfig: jest.fn(),
  streamPluginConfig: jest.fn(),
}));
jest.unstable_mockModule('../src/services/similar-plugin-lookup.js', () => ({
  findSimilarPlugins: jest.fn(async () => []),
}));

// Heavy sibling route factories are stubbed. read stands in for `GET /plugins`.
jest.unstable_mockModule('../src/routes/read-plugins.js', () => ({
  createReadPluginRoutes: () => {
    const r = Router();
    r.get('/', (_req, res) => res.status(200).json({ plugins: [] }));
    return r;
  },
}));
jest.unstable_mockModule('../src/routes/upload-plugin.js', () => ({ createUploadPluginRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/queue-status.js', () => ({ createQueueStatusRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/deploy-generated-plugin.js', () => ({ createDeployGeneratedPluginRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/update-plugin.js', () => ({ createUpdatePluginRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/delete-plugin.js', () => ({ createDeletePluginRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/bulk-plugin.js', () => ({ createBulkPluginRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/restore-plugin.js', () => ({ createRestorePluginRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/purge-plugin.js', () => ({ createPurgePluginRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/public-directory.js', () => ({ createPublicDirectoryRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/public-submissions.js', () => ({ createPublicSubmissionRoutes: () => Router() }));
// Purge-scheduler deps the index now imports — mock so the real pipeline-data
// barrel / pluginService aren't pulled into this route-mount test.
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService: {} }));
const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', { ...actualData, createSoftDeletePurgeScheduler: () => null }));
jest.unstable_mockModule('../src/routes/publisher.js', () => ({ createPublisherRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/installs.js', () => ({ createInstallRoutes: () => Router() }));
jest.unstable_mockModule('../src/routes/ecosystem-console.js', () => ({ createEcosystemConsoleRoutes: () => Router() }));
// The real module (EcosystemError, callerFromRequest …) with boot wiring stubbed.
const realEcosystemContext = await import('../src/services/ecosystem/context.js');
jest.unstable_mockModule('../src/services/ecosystem/context.js', () => ({ ...realEcosystemContext, initEcosystem: jest.fn() }));
jest.unstable_mockModule('../src/services/ecosystem/publishers.js', () => ({ ensureOfficialPublisher: jest.fn(async () => ({})) }));
// app-routes registers the review → advisory seam at mount; the advisory service itself is not under test.
jest.unstable_mockModule('../src/services/ecosystem/advisories.js', () => ({ deprecateListedFromSource: jest.fn(), openReviewAdvisoryDraft: jest.fn() }));
jest.unstable_mockModule('../src/services/ecosystem/maintenance.js', () => ({
  createEcosystemMaintenanceScheduler: () => ({ start: () => undefined, stop: () => undefined }),
}));
// The ecosystem gauge sampler — index.ts builds + starts it at boot.
jest.unstable_mockModule('../src/services/ecosystem/metrics.js', () => ({
  createEcosystemMetricsScheduler: () => ({ start: () => undefined, stop: () => undefined }),
  recordDecision: () => undefined,
}));

// Import the REAL boot module — assembles the production route wiring, incl. the
// REAL generate router at the actual '/plugins' generate mount.
await import('../src/index.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = capturedApp.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function request(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    if (method !== 'GET') req.write('{}');
    req.end();
  });
}

const LOW_PRIV = { 'x-org-id': 'acme' };

describe('plugin mount-guard leak — reads are not gated by the generate feature guard', () => {
  it('GET /plugins succeeds WITHOUT the ai_generation feature (leak gone)', async () => {
    const res = await request('GET', '/plugins', LOW_PRIV);
    expect(res.status).toBe(200);
  });

  it('GET /plugins is NOT 403 even though the generate mount shares the prefix', async () => {
    const res = await request('GET', '/plugins', LOW_PRIV);
    expect(res.status).not.toBe(403);
  });
});

describe('plugin mount-guard leak — generate routes still enforce ai_generation', () => {
  it('POST /plugins/generate → 403 without ai_generation', async () => {
    const res = await request('POST', '/plugins/generate', LOW_PRIV);
    expect(res.status).toBe(403);
  });

  it('POST /plugins/generate → passes the gate WITH ai_generation (400 stub body, not 403)', async () => {
    const res = await request('POST', '/plugins/generate', { ...LOW_PRIV, 'x-test-features': 'ai_generation' });
    expect(res.status).toBe(400);
  });

  it('GET /plugins/providers → 403 without ai_generation, 200 with it', async () => {
    expect((await request('GET', '/plugins/providers', LOW_PRIV)).status).toBe(403);
    expect((await request('GET', '/plugins/providers', { ...LOW_PRIV, 'x-test-features': 'ai_generation' })).status).toBe(200);
  });
});
