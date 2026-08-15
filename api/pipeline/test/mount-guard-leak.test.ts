// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral regression lock-in for the "mount-guard leak" fix.
 *
 * The generate / bulk / execution concerns used to be mounted as
 * `app.use('/pipelines', ...guards, subRouter)`. Because Express runs prefix
 * middleware for ANY request under the prefix, `requireFeature('ai_generation')`
 * / `requireFeature('bulk_operations')` / `requirePermission('pipelines:write')`
 * leaked onto sibling reads, 403'ing a lower-tier / lesser-permission user on a
 * plain `GET /pipelines`.
 *
 * This suite imports the REAL src/index.ts wiring (createApp returns a real
 * Express app; every heavy dependency is mocked) and drives real HTTP requests
 * through the assembled app with FAITHFUL feature/permission guards, proving:
 *   1. a user with NO features and NO capabilities can still `GET /pipelines`;
 *   2. the generate / bulk / execution write routes STILL enforce their
 *      feature + permission (403 without, passes the gate with).
 */

import http from 'node:http';

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Real Express app that src/index.ts will mount its routers onto (via the
// mocked createApp). express.json() is added here so it runs before the
// request-context middleware and the routers, mirroring production ordering.
const capturedApp = express();
capturedApp.use(express.json());

// -- Faithful RBAC guards -----------------------------------------------------
// These mirror api-core's real requireFeature / requirePermission semantics
// closely enough to prove WHERE the guard runs (the thing this fix changes).
const featureGuard = (feature: string) => (req: any, res: any, next: () => void) => {
  if (!req.user) return res.status(401).json({ message: 'unauthenticated' });
  if (req.user.isSuperAdmin) return next();
  return req.user.features?.includes(feature)
    ? next()
    : res.status(403).json({ message: `feature required: ${feature}` });
};
const permissionGuard = (...perms: string[]) => (req: any, res: any, next: () => void) => {
  const caps: string[] = req.user?.capabilities ?? [];
  return perms.every((p) => caps.includes(p))
    ? next()
    : res.status(403).json({ message: `permission required: ${perms.join(',')}` });
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({ increment: jest.fn(), check: jest.fn(), getUsage: jest.fn() }),
  registerComplianceEventSubscriber: jest.fn(),
  requireFeature: (feature: string) => featureGuard(feature),
  requirePermission: (...perms: string[]) => permissionGuard(...perms),
  createComplianceClient: () => ({ validatePipeline: jest.fn(async () => ({ blocked: false, violations: [] })) }),
  getParam: (p: any, k: string) => p?.[k],
  // Reads: validateQuery must pass so the list handler produces a 200.
  validateQuery: () => ({ ok: true, value: {} }),
  parsePaginationParams: () => ({ limit: 25, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' }),
  normalizeArrayFields: (p: any) => p,
  // Writes: fail body/bulk validation AFTER the gate so an allowed write lands a
  // 400 (not 403) — proving the gate let it through without running real work.
  validateBody: () => ({ ok: false, error: 'stub-invalid-body' }),
  validateBulkArray: () => ({ error: 'stub-invalid-bulk' }),
  reserveQuota: async () => ({ exceeded: false, quota: { type: 'aiCalls', limit: 1, used: 0, remaining: 1, resetAt: 0 } }),
  decrementQuota: jest.fn(),
  sendPaginatedNested: (res: any, key: string, data: any, opts: any) =>
    res.status(200).json({ [key]: data, pagination: opts }),
  sendSuccess: (res: any, statusCode: number, data?: any, message?: string) =>
    res.status(statusCode).json({ success: true, statusCode, data, message }),
  sendBadRequest: (res: any, msg: string) =>
    res.status(400).json({ success: false, statusCode: 400, message: msg }),
  sendError: (res: any, statusCode: number, msg: string) =>
    res.status(statusCode).json({ success: false, statusCode, message: msg }),
  sendQuotaExceeded: (res: any) => res.status(429).json({ success: false, statusCode: 429 }),
  sendEntityNotFound: (res: any, entity: string) => res.status(404).json({ message: `${entity} not found` }),
  sendInternalError: (res: any, msg: string) => res.status(500).json({ message: msg }),
  handleAIError: (res: any, msg: string) => res.status(500).json({ message: msg }),
  // Remaining named exports the route factories import — inert stubs so ESM
  // linking against the mock resolves every symbol.
  createSafeClient: () => ({ post: jest.fn() }),
  initSSEStream: () => ({ aborted: () => false }),
  isSystemAdmin: () => false,
  pickDefined: (o: any) => o,
  requirePublicAccess: () => true,
  resolveAccessModifier: (_req: any, am?: string) => am ?? 'private',
  runConcurrent: async <T, R>(items: T[], _max: number, fn: (i: T) => Promise<R>) => Promise.all(items.map(fn)),
  PipelineCreateSchema: {},
  PipelineUpdateSchema: {},
  PipelineFilterSchema: {},
  AIGenerateBodySchema: {},
  AIGenerateFromUrlBodySchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  checkQuota: () => (_req: any, _res: any, next: () => void) => next(),
  // Return the real Express app so index.ts assembles production wiring onto it.
  createApp: () => ({ app: capturedApp, sseManager: {} }),
  runServer: jest.fn(),
  postgresHealthCheck: () => async () => ({ ok: true }),
  // Auth/quota chains are exercised elsewhere; here they are no-ops so the test
  // controls req.user via the request-context middleware below.
  createProtectedRoute: () => [],
  createAuthenticatedWithOrgRoute: () => [],
  // Stand-in for attachRequestContext: seed req.user + req.context from headers.
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
  incrementQuotaFromCtx: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  runMigrations: jest.fn(async () => undefined),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({}),
  schema: {},
  // Scorecard route calls per-pipeline DORA in-process; stub the singleton.
  reportingService: { getDoraMetrics: jest.fn(async () => ({})) },
  // Retention purge scheduler wired in index.ts; null disables it in the test.
  createSoftDeletePurgeScheduler: () => null,
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({ services: { pluginHost: 'localhost', pluginPort: 0 } }) },
  CoreConstants: {
    SSE_STREAM_TIMEOUT_MS: 1000,
    MAX_BULK_ITEMS: 100,
    CACHE_CONTROL_LIST: 'private',
    CACHE_CONTROL_DETAIL: 'private',
  },
  AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
  replaceNonAlphanumeric: (s: string, r: string) => s.replace(/[^a-zA-Z0-9]/g, r),
  // Template routes tokenize the body to find undeclared-var references.
  tokenize: () => [],
}));

// -- Service / helper stubs (routers must import; reads return empty) ---------
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPipelineAudit: jest.fn(),
  getAuditClient: () => ({ record: jest.fn() }),
}));
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    findPaginated: jest.fn(async () => ({ data: [], total: 0, limit: 25, offset: 0, hasMore: false })),
    find: jest.fn(async () => []),
    findById: jest.fn(async () => null),
    findByIds: jest.fn(async () => []),
    createAsDefault: jest.fn(),
    createAsDefaultReportInserted: jest.fn(),
    bulkDelete: jest.fn(async () => []),
    update: jest.fn(),
    setDefault: jest.fn(),
  },
  // Scorecard route imports this projection helper alongside the service.
  toComplianceAttributes: (x: unknown) => x,
}));
jest.unstable_mockModule('../src/services/pipeline-registry-service.js', () => ({
  pipelineRegistryService: { findByPipelineId: jest.fn(), upsert: jest.fn(), findPaginated: jest.fn() },
  PR_PIPELINE_NOT_OWNED: 'PR_PIPELINE_NOT_OWNED',
  PR_REGISTRY_OWNED_BY_OTHER_ORG: 'PR_REGISTRY_OWNED_BY_OTHER_ORG',
}));
const mockTriggerExecution = jest.fn(async () => ({ executionId: 'exec-1' }));
jest.unstable_mockModule('../src/services/pipeline-execution-service.js', () => ({
  pipelineExecutionService: { triggerExecution: mockTriggerExecution, stopExecution: jest.fn() },
  PipelineExecutionError: class PipelineExecutionError extends Error {},
  PE_PIPELINE_NOT_REGISTERED: 'PE_PIPELINE_NOT_REGISTERED',
  PE_AWS_PIPELINE_NOT_FOUND: 'PE_AWS_PIPELINE_NOT_FOUND',
  PE_NOT_STOPPABLE: 'PE_NOT_STOPPABLE',
  PE_AWS_ERROR: 'PE_AWS_ERROR',
}));
jest.unstable_mockModule('../src/services/ai-generation-service.js', () => ({
  AIEmptyOutputError: class AIEmptyOutputError extends Error {},
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
  resolvePipeline_: jest.fn(),
}));
jest.unstable_mockModule('../src/services/pipeline-template-service.js', () => ({
  pipelineTemplateService: {
    findPaginated: jest.fn(async () => ({ data: [], total: 0, limit: 25, offset: 0, hasMore: false })),
    find: jest.fn(async () => []),
    findById: jest.fn(async () => null),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

// Import the REAL boot module — this assembles the production route wiring.
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

/** Minimal HTTP driver returning { status } (body ignored). */
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

// A lower-tier / lesser-permission caller: authenticated, but no features and
// no write capability.
const LOW_PRIV = { 'x-org-id': 'acme' };

describe('mount-guard leak — reads are not gated by sibling write guards', () => {
  it('GET /pipelines succeeds with NO features and NO capabilities (leak gone)', async () => {
    const res = await request('GET', '/pipelines', LOW_PRIV);
    expect(res.status).toBe(200);
  });

  it('GET /pipelines is NOT 403 even though generate/bulk/execution mounts share the prefix', async () => {
    const res = await request('GET', '/pipelines', LOW_PRIV);
    expect(res.status).not.toBe(403);
  });
});

describe('mount-guard leak — write routes still enforce feature + permission', () => {
  it('POST /pipelines/generate → 403 without ai_generation', async () => {
    const res = await request('POST', '/pipelines/generate', LOW_PRIV);
    expect(res.status).toBe(403);
  });

  it('POST /pipelines/generate → passes the gate WITH ai_generation (400 stub body, not 403)', async () => {
    const res = await request('POST', '/pipelines/generate', { ...LOW_PRIV, 'x-test-features': 'ai_generation' });
    expect(res.status).toBe(400);
  });

  it('GET /pipelines/providers → 403 without ai_generation, 200 with it', async () => {
    expect((await request('GET', '/pipelines/providers', LOW_PRIV)).status).toBe(403);
    expect((await request('GET', '/pipelines/providers', { ...LOW_PRIV, 'x-test-features': 'ai_generation' })).status).toBe(200);
  });

  it('POST /pipelines/bulk/create → 403 without pipelines:write', async () => {
    const res = await request('POST', '/pipelines/bulk/create', LOW_PRIV);
    expect(res.status).toBe(403);
  });

  it('POST /pipelines/bulk/create → 403 with pipelines:write but WITHOUT bulk_operations', async () => {
    const res = await request('POST', '/pipelines/bulk/create', { ...LOW_PRIV, 'x-test-caps': 'pipelines:write' });
    expect(res.status).toBe(403);
  });

  it('POST /pipelines/bulk/create → passes the gate WITH write + bulk_operations (400 stub body, not 403)', async () => {
    const res = await request('POST', '/pipelines/bulk/create', {
      ...LOW_PRIV, 'x-test-caps': 'pipelines:write', 'x-test-features': 'bulk_operations',
    });
    expect(res.status).toBe(400);
  });

  it('POST /pipelines/:id/executions → 403 without pipelines:write', async () => {
    const res = await request('POST', '/pipelines/p-1/executions', LOW_PRIV);
    expect(res.status).toBe(403);
  });

  it('POST /pipelines/:id/executions → passes the gate WITH pipelines:write (202, not 403)', async () => {
    const res = await request('POST', '/pipelines/p-1/executions', { ...LOW_PRIV, 'x-test-caps': 'pipelines:write' });
    expect(res.status).toBe(202);
  });
});
