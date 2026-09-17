// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring lock-in for the `/pipelines` mount order in src/index.ts.
 *
 * Imports the REAL boot module and drives real HTTP through the assembled app.
 * The shared auth chains use api-server's REAL `idempotencyMiddleware` (the
 * thing that double-ran), with a header-driven auth stand-in in front of it;
 * only infrastructure (DB services, quota transport, S2S clients) is stubbed.
 *
 * Locks in:
 *   A. `GET /pipelines/scorecard` (org roll-up) reaches the scorecard router —
 *      it used to be captured by the read router's `GET /:id` and 404.
 *   B. A keyed mutation passes the idempotency middleware exactly ONCE. Stacked
 *      `createAuthenticatedWithOrgRoute()` / `createProtectedRoute()` mounts ran
 *      it once per mount with the same key, so the second pass saw the request's
 *      own pending reservation and 409'd (PUT/DELETE /:id, POST /:id/purge,
 *      POST /:id/restore, PUT /bulk/update).
 *   …without loosening auth, the write permission, step-up, or the apiCalls check.
 */

import http from 'node:http';

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import { apiCoreMock } from './helpers/mock-api-core.js';

const capturedApp = express();
capturedApp.use(express.json());

// -- Per-request pass counters --------------------------------------------------
const passes = { auth: 0, apiCallsCheck: 0, stepUp: 0 };
const resetPasses = () => { passes.auth = 0; passes.apiCallsCheck = 0; passes.stepUp = 0; };

const list = (h: unknown) => (typeof h === 'string' && h ? h.split(',') : []);

// Faithful guards (mirror api-core semantics closely enough to prove WHERE they run).
const permissionGuard = (...perms: string[]) => (req: any, res: any, next: () => void) => (
  perms.every((p) => (req.user?.capabilities ?? []).includes(p))
    ? next()
    : res.status(403).json({ message: `permission required: ${perms.join(',')}` })
);
const featureGuard = (feature: string) => (req: any, res: any, next: () => void) => (
  (req.user?.features ?? []).includes(feature) ? next() : res.status(403).json({ message: `feature required: ${feature}` })
);
const stepUpGuard = (req: any, res: any, next: () => void) => {
  passes.stepUp++;
  return req.headers['x-test-stepup'] === 'ok' ? next() : res.status(401).json({ message: 'step-up required' });
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({ increment: jest.fn(), check: jest.fn(), getUsage: jest.fn() }),
  registerComplianceEventSubscriber: jest.fn(),
  requireFeature: featureGuard,
  requirePermission: permissionGuard,
  requireStepUp: stepUpGuard,
  getParam: (p: any, k: string) => p?.[k],
  validateQuery: () => ({ ok: true, value: {} }),
  validateBody: () => ({ ok: true, value: {} }),
  validateBulkArray: () => ({ error: 'stub-invalid-bulk' }),
  parsePaginationParams: () => ({ limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
  normalizeArrayFields: (p: any) => p,
  pickDefined: (o: any) => o,
  reserveQuota: async () => ({ exceeded: false, quota: { resetAt: '' } }),
  decrementQuota: jest.fn(),
  loadAndPurge: async (_req: any, res: any) => { res.status(404).json({ message: 'Pipeline not found' }); return null; },
  loadAndRestore: async (_req: any, res: any) => { res.status(404).json({ message: 'Pipeline not found' }); return null; },
  sendPaginatedNested: (res: any, key: string, data: any) => res.status(200).json({ [key]: data }),
  sendSuccess: (res: any, statusCode: number, data?: any) => res.status(statusCode).json({ success: true, data }),
  sendBadRequest: (res: any, msg: string) => res.status(400).json({ message: msg }),
  sendError: (res: any, statusCode: number, msg: string) => res.status(statusCode).json({ message: msg }),
  sendEntityNotFound: (res: any, entity: string) => res.status(404).json({ message: `${entity} not found` }),
  sendInternalError: (res: any, msg: string) => res.status(500).json({ message: msg }),
  handleAIError: (res: any, msg: string) => res.status(500).json({ message: msg }),
  createSafeClient: () => ({ post: jest.fn() }),
  initSSEStream: () => ({ aborted: () => false }),
  checkVisibilityWriteAccess: () => 'ok',
  runConcurrent: async <T, R>(items: T[], _max: number, fn: (i: T) => Promise<R>) => Promise.all(items.map(fn)),
  PipelineCreateSchema: {},
  PipelineUpdateSchema: {},
  PipelineFilterSchema: {},
  AIGenerateBodySchema: {},
  AIGenerateFromUrlBodySchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({ services: { pluginHost: 'localhost', pluginPort: 0 } }) },
  CoreConstants: {
    SSE_STREAM_TIMEOUT_MS: 1000,
    MAX_BULK_ITEMS: 100,
    CACHE_CONTROL_LIST: 'private',
    CACHE_CONTROL_DETAIL: 'private',
    // Read by the real idempotency middleware.
    IDEMPOTENCY_TTL_MS: 60_000,
    IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000,
    IDEMPOTENCY_MAX_STORE_SIZE: 1000,
  },
  replaceNonAlphanumeric: (s: string, r: string) => s.replace(/[^a-zA-Z0-9]/g, r),
  tokenize: () => [],
}));

// The REAL idempotency middleware (a subpath import, so the api-server mock
// below doesn't shadow it). It links against the api-core / pipeline-core mocks.
const { idempotencyMiddleware } = await import('@pipeline-builder/api-server/lib/api/idempotency-middleware.js');

/** Auth + orgId stand-in: seeds the VERIFIED identity the idempotency key is namespaced on. */
const authStandIn = (req: any, _res: any, next: () => void) => {
  passes.auth++;
  const orgId = (req.headers['x-org-id'] as string) || 'acme';
  req.user = {
    sub: 'user-1',
    organizationId: orgId,
    features: list(req.headers['x-test-features']),
    capabilities: list(req.headers['x-test-caps']),
  };
  req.context = { identity: { orgId, userId: 'user-1' }, log: jest.fn(), requestId: 'req-1' };
  next();
};
/** Mirrors api-server's chain shape: auth → orgId → idempotency (→ tenant scope). */
const authChain = () => [authStandIn, idempotencyMiddleware()];

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  checkQuota: (_qs: unknown, type: string) => (_req: any, _res: any, next: () => void) => {
    if (type === 'apiCalls') passes.apiCallsCheck++;
    next();
  },
  createApp: () => ({ app: capturedApp, sseManager: {} }),
  runServer: jest.fn(),
  postgresHealthCheck: () => async () => ({ ok: true }),
  createAuthenticatedWithOrgRoute: authChain,
  createProtectedRoute: authChain,
  rateLimitByOrg: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  attachRequestContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  withRoute: (handler: any) => async (req: any, res: any) => {
    try {
      await handler({ req, res, ctx: req.context, orgId: req.context.identity.orgId, userId: 'user-1' });
    } catch (err: any) {
      res.status(500).json({ message: err?.message ?? String(err) });
    }
  },
  incrementQuotaFromCtx: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({}),
  schema: {},
  reportingService: {
    getDoraMetrics: jest.fn(async () => ({})),
    getIncidentSettings: jest.fn(async () => ({ incidentWindowHours: null })),
  },
  createSoftDeletePurgeScheduler: () => null,
}));

jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPipelineAudit: jest.fn(),
  getAuditClient: () => ({ record: jest.fn() }),
}));
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    findPaginated: jest.fn(async () => ({ data: [], total: 0, limit: 25, offset: 0, hasMore: false })),
    findFirst: jest.fn(async () => null),
    findDeleted: jest.fn(async () => []),
    findById: jest.fn(async () => null),
    findByIds: jest.fn(async () => []),
    update: jest.fn(),
    setDefault: jest.fn(),
    delete: jest.fn(),
  },
  toComplianceAttributes: (x: unknown) => x,
}));
jest.unstable_mockModule('../src/services/pipeline-registry-service.js', () => ({
  pipelineRegistryService: { list: jest.fn(async () => ({ rows: [], total: 0 })), upsert: jest.fn() },
  PR_PIPELINE_NOT_OWNED: 'PR_PIPELINE_NOT_OWNED',
  PR_REGISTRY_OWNED_BY_OTHER_ORG: 'PR_REGISTRY_OWNED_BY_OTHER_ORG',
}));
jest.unstable_mockModule('../src/services/pipeline-execution-service.js', () => ({
  pipelineExecutionService: { triggerExecution: jest.fn(async () => ({ executionId: 'exec-1' })), stopExecution: jest.fn() },
  PipelineExecutionError: class PipelineExecutionError extends Error {},
  PE_PIPELINE_NOT_REGISTERED: 'PE_PIPELINE_NOT_REGISTERED',
  PE_AWS_PIPELINE_NOT_FOUND: 'PE_AWS_PIPELINE_NOT_FOUND',
  PE_NOT_STOPPABLE: 'PE_NOT_STOPPABLE',
  PE_AWS_ERROR: 'PE_AWS_ERROR',
}));
jest.unstable_mockModule('../src/services/ai-generation-service.js', () => ({
  getAvailableProviders: jest.fn(() => []),
  getFilteredPlugins: jest.fn(async () => []),
  generatePipelineConfig: jest.fn(),
  streamPipelineConfig: jest.fn(),
}));
jest.unstable_mockModule('../src/services/git-analysis-service.js', () => ({
  parseGitUrl: jest.fn(() => null),
  analyzeRepository: jest.fn(),
  buildEnhancedPrompt: jest.fn(),
}));
jest.unstable_mockModule('../src/services/plugin-lookup-service.js', () => ({
  findExistingPluginNames: jest.fn(async () => new Set()),
}));
jest.unstable_mockModule('../src/helpers/pipeline-template-validator.js', () => ({
  validatePipelineTemplates: jest.fn(),
  resolvePipeline: jest.fn(),
}));
jest.unstable_mockModule('../src/services/pipeline-template-service.js', () => ({
  pipelineTemplateService: {
    findPaginated: jest.fn(async () => ({ data: [], total: 0, limit: 25, offset: 0, hasMore: false })),
    findById: jest.fn(async () => null),
  },
}));

await import('../src/index.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = capturedApp.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(resetPasses);

let keySeq = 0;
/** A fresh Idempotency-Key per call, so only a within-request double pass can collide. */
const freshKey = () => ({ 'idempotency-key': `key-${++keySeq}` });

function request(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = method === 'GET' ? '' : '{"x":1}';
    // Explicit Content-Length: Node doesn't chunk-encode DELETE bodies by default.
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const WRITER = { 'x-org-id': 'acme', 'x-test-caps': 'pipelines:write' };
const ID = '10000000-0000-4000-8000-000000000001';

describe('A — scorecard routes are not shadowed by GET /:id', () => {
  it('GET /pipelines/scorecard serves the org roll-up (not a "Pipeline not found" 404)', async () => {
    const res = await request('GET', '/pipelines/scorecard', { 'x-test-features': 'advanced_reporting' });
    expect(res.status).toBe(200);
    expect(res.body.data.rollup).toEqual(expect.objectContaining({ orgId: 'acme', pipelineCount: 0 }));
    expect(passes).toEqual({ auth: 1, apiCallsCheck: 1, stepUp: 0 });
  });

  it('GET /pipelines/:id/scorecard is a read: no pipelines:write needed', async () => {
    const res = await request('GET', `/pipelines/${ID}/scorecard`, { 'x-test-features': 'advanced_reporting' });
    expect(res.status).toBe(404); // reached the handler (stub findById → null), not a 403
    expect(res.body.message).toBe('Pipeline not found');
  });

  it('GET /pipelines/:id still resolves through the read router', async () => {
    const res = await request('GET', `/pipelines/${ID}`);
    expect(res.status).toBe(404);
    expect(passes).toEqual({ auth: 1, apiCallsCheck: 1, stepUp: 0 });
  });
});

describe('B — a keyed mutation passes the idempotency middleware once', () => {
  it('PUT /pipelines/:id with an Idempotency-Key is not 409\'d by its own reservation', async () => {
    const res = await request('PUT', `/pipelines/${ID}`, { ...WRITER, ...freshKey() });
    expect(res.status).toBe(404);
    // One auth/idempotency pass; the apiCalls check still runs (once) as before.
    expect(passes).toEqual({ auth: 1, apiCallsCheck: 1, stepUp: 0 });
  });

  it('DELETE /pipelines/:id with an Idempotency-Key is not 409\'d', async () => {
    const res = await request('DELETE', `/pipelines/${ID}`, { ...WRITER, ...freshKey() });
    expect(res.status).toBe(404);
    expect(passes.auth).toBe(1);
  });

  it.each(['purge', 'restore'])('POST /pipelines/:id/%s with an Idempotency-Key is not 409\'d; step-up runs once', async (op) => {
    const res = await request('POST', `/pipelines/${ID}/${op}`, { ...WRITER, 'x-test-stepup': 'ok', ...freshKey() });
    expect(res.status).toBe(404);
    expect(passes).toEqual({ auth: 1, apiCallsCheck: 1, stepUp: 1 });
  });

  it('PUT /pipelines/bulk/update with an Idempotency-Key is not 409\'d', async () => {
    const res = await request('PUT', '/pipelines/bulk/update', {
      ...WRITER, 'x-test-features': 'bulk_operations', ...freshKey(),
    });
    expect(res.status).toBe(400); // stub bulk validation — past every guard
    expect(passes).toEqual({ auth: 1, apiCallsCheck: 0, stepUp: 0 });
  });

  it('POST /pipelines/:id/executions runs its own chain only', async () => {
    const res = await request('POST', `/pipelines/${ID}/executions`, { ...WRITER, ...freshKey() });
    expect(res.status).toBe(202);
    expect(passes.auth).toBe(1);
  });

  it('a completed keyed write is still replayed on retry (idempotency still applies)', async () => {
    const headers = { ...WRITER, ...freshKey() };
    const first = await request('POST', `/pipelines/${ID}/executions`, headers);
    const retry = await request('POST', `/pipelines/${ID}/executions`, headers);
    expect(first.status).toBe(202);
    expect(first.headers['x-idempotent-replayed']).toBe('false');
    expect(retry.status).toBe(202);
    expect(retry.headers['x-idempotent-replayed']).toBe('true');
  });
});

describe('gates are unchanged by the single shared chain', () => {
  it('PUT /pipelines/:id without pipelines:write → 403', async () => {
    expect((await request('PUT', `/pipelines/${ID}`, { 'x-org-id': 'acme' })).status).toBe(403);
  });

  it('POST /pipelines/:id/purge without step-up → 401', async () => {
    expect((await request('POST', `/pipelines/${ID}/purge`, WRITER)).status).toBe(401);
  });

  it('GET /pipelines/registry is served without the apiCalls check (as before)', async () => {
    const res = await request('GET', '/pipelines/registry');
    expect(res.status).toBe(200);
    expect(passes).toEqual({ auth: 1, apiCallsCheck: 0, stepUp: 0 });
  });

  it('POST /pipelines/registry still requires pipelines:write', async () => {
    expect((await request('POST', '/pipelines/registry', { 'x-org-id': 'acme' })).status).toBe(403);
  });
});
