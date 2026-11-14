// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock function references  must be defined before jest.mock() calls

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockParseGitUrl = jest.fn<AnyFn>();
const mockAnalyzeRepository = jest.fn<AnyFn>();
const mockBuildEnhancedPrompt = jest.fn<AnyFn>();
const mockStreamPipelineConfig = jest.fn<AnyFn>();
const mockGetAvailableProviders = jest.fn<AnyFn>();
const mockValidateBody = jest.fn<AnyFn>();
const mockSendBadRequest = jest.fn<AnyFn>();
const mockSendInternalError = jest.fn<AnyFn>();
const mockSendSuccess = jest.fn<AnyFn>();
const mockSendQuotaReserveDenied = jest.fn<AnyFn>();
const mockCreateSafeClient = jest.fn<AnyFn>();
const mockPluginClientPost = jest.fn<AnyFn>();
const mockDbSelect = jest.fn<AnyFn>();
const mockReserveQuota = jest.fn<(...args: any[]) => any>().mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', limit: 1000, used: 1, remaining: 999 } });
const mockDecrementQuota = jest.fn<AnyFn>();
const mockRecordAudit = jest.fn<AnyFn>();

// Mocks  must be defined before imports

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: (...args: any[]) => {
    mockCreateSafeClient(...args);
    return { post: mockPluginClientPost };
  },
  initSSEStream: jest.fn((req: any, res: any, timeoutMs: number) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setTimeout(timeoutMs);
    res.flushHeaders?.();
    let _aborted = false;
    req.on('close', () => { _aborted = true; });
    const send = (event: unknown) => { if (!_aborted) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    return {
      signal: new AbortController().signal,
      aborted: () => _aborted,
      send,
      done: (event?: unknown) => { if (_aborted) return; if (event !== undefined) send(event); res.write('data: [DONE]\n\n'); },
    };
  }),
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
  handleAIError: jest.fn((res: any, error: unknown, fallbackMessage: string) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      if (message.includes('not configured') || message.includes('API key')) {
        return mockSendInternalError(res, 'AI generation is not configured for the requested provider');
      }
      if (message.includes('not available for provider')) {
        return mockSendBadRequest(res, message);
      }
      return mockSendInternalError(res, fallbackMessage, { details: message });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    res.end();
  }),
  sendBadRequest: mockSendBadRequest.mockImplementation((res: any, msg: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg });
  }),
  sendInternalError: mockSendInternalError.mockImplementation((res: any, msg: string, details?: any) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg, ...details });
  }),
  sendSuccess: mockSendSuccess.mockImplementation((res: any, statusCode: number, data?: any) => {
    const response: any = { success: true, statusCode };
    if (data !== undefined) response.data = data;
    res.status(statusCode).json(response);
  }),
  validateBody: mockValidateBody,
  AIGenerateFromUrlBodySchema: {},
  AIGenerateBodySchema: {},
  // reserve+rollback. Default: not exceeded.
  reserveQuota: (...args: unknown[]) => mockReserveQuota(...args),
  decrementQuota: (...args: unknown[]) => mockDecrementQuota(...args),
  sendQuotaReserveDenied: (...args: unknown[]) => mockSendQuotaReserveDenied(...args),
  // Concurrency-bounded fan-out helper used by autoCreateMissingPlugins. Tests
  // don't care about the concurrency bound — run sequentially and aggregate.
  runConcurrent: async <T, R>(items: T[], _max: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = [];
    for (const item of items) results.push(await fn(item));
    return results;
  },
}));

// Shared ctx.log spy so tests can assert what the handler logs — e.g. that a
// gitUrl carrying embedded credentials is never logged. Cleared per test.
const mockCtxLog = jest.fn<AnyFn>();

// Each call builds a distinct limiter (its own bucket without a Redis store),
// so the routes must share ONE instance to share the burst cap.
const mockRateLimitByOrg = jest.fn((..._args: unknown[]) => {
  const limiter = (_req: unknown, _res: unknown, next: () => void) => next();
  return limiter;
});

// The REAL reservation helper (its api-core calls hit this file's api-core mock).
let realWithAiCallReservation: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withAiCallReservation: (...a: any[]) => realWithAiCallReservation(...a),
  incCounter: () => undefined,
  observe: () => undefined,
  createAuthenticatedWithOrgRoute: () => [],
  rateLimitByOrg: (...args: unknown[]) => mockRateLimitByOrg(...args),
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = {
      identity: { orgId: req.context?.identity?.orgId || 'test-org' },
      log: mockCtxLog,
      requestId: 'test-req-id',
    };
    const orgId = (ctx.identity.orgId || '').toLowerCase();
    try {
      await handler({ req, res, ctx, orgId, userId: 'test-user' });
    } catch (error: any) {
      // Let it propagate for test assertions
    }
  },
}));

// Mock drizzle-orm operators as identity/passthrough functions
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  eq: jest.fn((_col: any, _val: any) => ({ type: 'eq', col: _col, val: _val })),
  or: jest.fn((...args: any[]) => ({ type: 'or', args })),
  and: jest.fn((...args: any[]) => ({ type: 'and', args })),
  isNull: jest.fn((_col: any) => ({ type: 'isNull', col: _col })),
  inArray: jest.fn((_col: any, _vals: any[]) => ({ type: 'inArray', col: _col, vals: _vals })),
}));

const mockDbChain = {
  from: jest.fn<AnyFn>().mockReturnThis(),
  where: jest.fn<AnyFn>().mockReturnThis(),
  limit: jest.fn<AnyFn>().mockResolvedValue([]),
  // Make the chain thenable so `await db.select().from().where()` resolves to []
  then: jest.fn((resolve: Function) => resolve([])),
};

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: {
    SSE_STREAM_TIMEOUT_MS: 300000,
  },
  Config: (() => {
    const get = (section: string) => {
      if (section === 'server') return { services: { pluginHost: 'plugin', pluginPort: 3000 } };
      return {};
    };
    return { get, getAny: get };
  })(),
}));
const mockResolvableListings = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
const mockGenListingSource = {
  liveListings: jest.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []),
  publishersByIds: jest.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []),
};
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  db: {
    select: (...args: any[]) => {
      mockDbSelect(...args);
      return mockDbChain;
    },
  },
  // findExistingPluginNames now reads through withTenantTx (RLS-safe); route the
  // tx's select to the same mockDbChain the bare-db path used.
  withTenantTx: (fn: (tx: { select: (...a: any[]) => unknown }) => unknown) => fn({
    select: (...args: any[]) => {
      mockDbSelect(...args);
      return mockDbChain;
    },
  }),
  schema: {
    pluginStats: { listingId: 'listingId', ratingBayes: 'ratingBayes', ratingCount: 'ratingCount', healthScore: 'healthScore' },
    plugin: {
      name: 'name',
      description: 'description',
      version: 'version',
      pluginType: 'pluginType',
      computeType: 'computeType',
      commands: 'commands',
      installCommands: 'installCommands',
      orgId: 'orgId',
      isActive: 'isActive',
      deletedAt: 'deletedAt',
      visibility: 'visibility',
    },
  },
  // Visibility-ladder predicate pieces plugin-lookup-service links against.
  // Listing resolution: no listings unless a test sets some.
  OFFICIAL_PUBLISHER_HANDLE: 'pipeline-builder',
  drizzleListingSource: () => mockGenListingSource,
  getTenantContext: () => undefined,
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
  resolvableListings: (...a: unknown[]) => mockResolvableListings(...a),
  buildPluginConditions: () => [],
  withViewerContext: (f: unknown) => f,
}));;

jest.unstable_mockModule('../src/services/git-analysis-service.js', () => ({
  parseGitUrl: mockParseGitUrl,
  analyzeRepository: mockAnalyzeRepository,
  buildEnhancedPrompt: mockBuildEnhancedPrompt,
}));

const mockGeneratePipelineConfig = jest.fn<(...args: any[]) => any>();

/** Mirrors the real service's provider-contacted sentinel — the route branches on
 *  `instanceof AIEmptyOutputError` to KEEP (not refund) the aiCalls slot. */
class AIEmptyOutputError extends Error {
  readonly providerContacted = true;
  constructor(message = 'AI did not produce a pipeline configuration') {
    super(message);
    this.name = 'AIEmptyOutputError';
  }
}

/** What `resolveOrgModelSelection` picked for the org (platform-key Claude unless a test says otherwise). */
const SELECTION = { model: { id: 'model' }, provider: 'anthropic', modelId: 'claude-sonnet-5', keySource: 'platform' };
const mockResolveOrgModelSelection = jest.fn<AnyFn>(async () => SELECTION);
jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  getAvailableProviders: mockGetAvailableProviders,
  resolveOrgModelSelection: (...a: unknown[]) => mockResolveOrgModelSelection(...a),
  // No failover in these suites (covered by ai-byo-key-no-fallback): run once on the selection.
  runWithFailover: async (selection: unknown, attempt: (s: unknown) => Promise<unknown>) => ({ value: await attempt(selection), selection, failedOver: [] }),
  aiUsageAuditDetails: (sel: any, extra: any) => ({ provider: sel.provider, model: sel.modelId, keySource: sel.keySource, quotaSlot: extra.quotaSlot, promptVersion: extra.promptVersion, tokens: extra.usage }),
}));
jest.unstable_mockModule('../src/services/plugin-catalog.js', () => ({
  getFilteredPlugins: jest.fn<(...args: any[]) => any>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../src/services/ai-generation-service.js', () => ({
  streamPipelineConfig: mockStreamPipelineConfig,
  generatePipelineConfig: mockGeneratePipelineConfig,
  AIEmptyOutputError,
  PIPELINE_PROMPT_VERSION: 'pipeline-generate@test',
}));

// Imports  after mocks

({ withAiCallReservation: realWithAiCallReservation } = await import('@pipeline-builder/api-server/lib/api/ai-call-reservation.js'));
const { createGeneratePipelineRoutes } = await import('../src/routes/generate-pipeline.js');

// Helpers

const stubQuotaService = { increment: jest.fn<AnyFn>().mockResolvedValue(undefined) } as any;
const router = createGeneratePipelineRoutes(stubQuotaService);
// Snapshot before any beforeEach clears the mock's call log.
const limiterCalls = mockRateLimitByOrg.mock.calls.map((args, i) => ({ opts: args[0] as { name: string }, limiter: mockRateLimitByOrg.mock.results[i].value }));

/**
 * Extract a route handler from the Express router by method and path.
 * Returns the LAST handler in the route stack (the actual handler, after any middleware).
 */
function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find( (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

/**
 * Create a mock Express request object.
 */
function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    body: {
      gitUrl: 'https://github.com/test/app',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    },
    headers: { authorization: 'Bearer test-token' },
    context: {
      identity: { orgId: 'TEST-ORG' },
      log: jest.fn<AnyFn>(),
      requestId: 'test-req-id',
    },
    on: jest.fn<AnyFn>(),
    ...overrides,
  };
}

/**
 * Create a mock SSE-capable Express response object.
 * Captures all written chunks for assertion.
 */
function mockSseRes(): any {
  const res: any = {};
  const chunks: string[] = [];
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  res.setHeader = jest.fn<AnyFn>();
  res.setTimeout = jest.fn<AnyFn>();
  res.flushHeaders = jest.fn<AnyFn>();
  res.write = jest.fn((chunk: string) => { chunks.push(chunk); return true; });
  res.end = jest.fn<AnyFn>();
  // clientAbortSignal listens for the response's 'close' (client disconnect).
  res.on = jest.fn<AnyFn>();
  res.headersSent = false;
  res.chunks = chunks;
  return res;
}

/**
 * Parse SSE chunks into structured event objects.
 * Each chunk is "data: <json>\n\n" or "data: [DONE]\n\n".
 */
function parseSseEvents(chunks: string[]): Array<{ type?: string; data?: any; message?: string } | string> {
  return chunks.map((chunk) => {
    const match = chunk.match(/^data: (.+)\n\n$/);
    if (!match) return chunk;
    const payload = match[1];
    if (payload === '[DONE]') return '[DONE]';
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  });
}

// Test Fixtures

const VALID_PARSED_URL = {
  host: 'github.com',
  owner: 'test',
  repo: 'app',
  provider: 'github',
};

const MOCK_ANALYSIS = {
  owner: 'test',
  repo: 'app',
  host: 'github.com',
  provider: 'github',
  defaultBranch: 'main',
  description: 'A test application',
  topics: ['nodejs', 'typescript'],
  languages: { TypeScript: 70, JavaScript: 30 },
  detectedFiles: ['package.json', 'tsconfig.json'],
  projectType: 'nodejs',
  hasDockerfile: false,
  hasCdkJson: false,
  packageManager: 'npm',
  frameworks: [],
};

const MOCK_FINAL_OUTPUT = {
  project: 'app',
  organization: 'test',
  description: 'CI/CD pipeline for test/app',
  keywords: ['nodejs', 'typescript'],
  synth: {
    source: { type: 'github', options: { repo: 'test/app', branch: 'main' } },
    plugin: { name: 'nodejs-build' },
  },
  stages: [
    {
      stageName: 'Deploy',
      steps: [
        { plugin: { name: 'cdk-deploy' } },
      ],
    },
  ],
};

const USAGE = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, totalTokens: 150 };

/**
 * Create a mock streamPipelineConfig result: an async generator of partials and
 * the service's validated `final` (description/keywords split off the props).
 */
function createMockStreamResult( partials: Record<string, unknown>[],
  finalOutput: Record<string, unknown> | null = MOCK_FINAL_OUTPUT,
) {
  async function* generate() {
    for (const partial of partials) {
      yield partial;
    }
  }
  const final = finalOutput
    ? (({ description, keywords, ...props }) => ({ props, description, keywords }))(finalOutput as Record<string, any>)
    : undefined;
  return {
    partialOutputStream: generate(),
    final: Promise.resolve(final),
    usage: Promise.resolve(USAGE),
    servedBy: { provider: 'anthropic', model: 'claude-sonnet-5' },
    promptVersion: 'pipeline-generate@test',
  };
}

/** The audit rows the run recorded (`pipeline.ai.generate`). */
function auditRows(): any[] {
  return mockRecordAudit.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.action === 'pipeline.ai.generate');
}

// Tests

describe('POST /generate/from-url/stream', () => {
  const handler = getHandler('post', '/generate/from-url/stream');

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations for the happy path
    mockValidateBody.mockReturnValue({
      ok: true,
      value: {
        gitUrl: 'https://github.com/test/app',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    });
    mockParseGitUrl.mockReturnValue(VALID_PARSED_URL);
    mockAnalyzeRepository.mockResolvedValue(MOCK_ANALYSIS);
    mockBuildEnhancedPrompt.mockReturnValue('Generated prompt for test/app');

    // Default: no plugins found in DB (for getAvailablePlugins)
    mockDbChain.from.mockReturnThis();
    mockDbChain.where.mockReturnThis();
    mockDbChain.limit.mockResolvedValue([]);
  });

  // Happy path  full streaming flow

  it('streams analyzing -> analyzed -> partial -> done -> [DONE] for a valid GitHub URL', async () => {
    const partials = [
      { project: 'app' },
      { project: 'app', organization: 'test' },
      { project: 'app', organization: 'test', synth: { source: { type: 'github' } } },
    ];

    // Final output has no stages at all, so the missing-plugins plan finds
    // no plugin names and no plugin events are sent
    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      description: 'CI/CD pipeline for test/app',
      keywords: ['nodejs'],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult(partials, finalOutputNoStages));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    // Verify SSE headers were set
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(res.setTimeout).toHaveBeenCalledWith(300000);
    expect(res.flushHeaders).toHaveBeenCalled();

    const events = parseSseEvents(res.chunks);

    // Event 1: analyzing
    expect(events[0]).toEqual({ type: 'analyzing' });

    // Event 2: analyzed  repo analysis data
    expect(events[1]).toEqual(expect.objectContaining({
      type: 'analyzed',
      data: expect.objectContaining({
        owner: 'test',
        repo: 'app',
        provider: 'github',
        defaultBranch: 'main',
        projectType: 'nodejs',
      }),
    }));

    // Events 3-5: partial streaming events
    expect(events[2]).toEqual({ type: 'partial', data: partials[0] });
    expect(events[3]).toEqual({ type: 'partial', data: partials[1] });
    expect(events[4]).toEqual({ type: 'partial', data: partials[2] });

    // Event 6: done with final props (description and keywords separated)
    expect(events[5]).toEqual(expect.objectContaining({
      type: 'done',
      data: expect.objectContaining({
        props: expect.objectContaining({
          project: 'app',
          organization: 'test',
        }),
        description: 'CI/CD pipeline for test/app',
        keywords: ['nodejs'],
        usage: USAGE,
        servedBy: { provider: 'anthropic', model: 'claude-sonnet-5' },
        promptVersion: 'pipeline-generate@test',
      }),
    }));

    // Event 7: [DONE] sentinel
    expect(events[6]).toBe('[DONE]');

    // Stream ended
    expect(res.end).toHaveBeenCalled();

    // Verify service calls
    expect(mockParseGitUrl).toHaveBeenCalledWith('https://github.com/test/app');
    expect(mockAnalyzeRepository).toHaveBeenCalledWith(VALID_PARSED_URL, undefined);
    expect(mockBuildEnhancedPrompt).toHaveBeenCalledWith(MOCK_ANALYSIS);
    expect(mockResolveOrgModelSelection).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'test-org', provider: 'anthropic', model: 'claude-sonnet-5' }));
    expect(mockStreamPipelineConfig).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Generated prompt for test/app', orgId: 'test-org' }),
      expect.objectContaining({ selection: SELECTION, signal: expect.any(AbortSignal), onProviderResponse: expect.any(Function) }),
    );

    // One audit row: who served it, whose key paid, tokens, prompt version, slot kept.
    expect(auditRows()).toEqual([expect.objectContaining({
      orgId: 'test-org',
      targetType: 'pipeline',
      outcome: 'success',
      details: expect.objectContaining({
        route: 'from-url-stream',
        gitProvider: 'github',
        quota: expect.objectContaining({ type: 'aiCalls', slot: 'kept', used: 1, limit: 1000 }),
        ai: expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-5', keySource: 'platform', quotaSlot: 'kept', promptVersion: 'pipeline-generate@test', tokens: USAGE }),
      }),
    })]);
    // The audit row never carries the prompt.
    expect(JSON.stringify(auditRows())).not.toContain('Generated prompt');
  });

  // Validation failures

  it('returns 400 when body validation fails (missing required fields)', async () => {
    mockValidateBody.mockReturnValue({ ok: false, error: 'gitUrl is required' });

    const req = mockReq({ body: {} });
    const res = mockSseRes();
    await handler(req, res);

    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'gitUrl is required');
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('returns 400 when git URL is invalid', async () => {
    mockValidateBody.mockReturnValue({
      ok: true,
      value: {
        gitUrl: 'not-a-valid-url',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    });
    mockParseGitUrl.mockReturnValue(null);

    const req = mockReq({ body: { gitUrl: 'not-a-valid-url', provider: 'anthropic', model: 'claude-sonnet-5' } });
    const res = mockSseRes();
    await handler(req, res);

    expect(mockSendBadRequest).toHaveBeenCalledWith( res,
      'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.',
    );
    expect(res.write).not.toHaveBeenCalled();
  });

  // Repository analysis failure

  it('sends SSE error event when repository analysis fails', async () => {
    mockAnalyzeRepository.mockRejectedValue(new Error('GitHub API error: 404'));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    // Should have analyzing event first
    expect(events[0]).toEqual({ type: 'analyzing' });

    // Then an error event
    expect(events[1]).toEqual({
      type: 'error',
      message: 'Repository analysis failed: GitHub API error: 404',
    });

    // Stream should end after the error
    expect(res.end).toHaveBeenCalled();

    // Should NOT have proceeded to streaming
    expect(mockStreamPipelineConfig).not.toHaveBeenCalled();
  });

  // Missing plugins are PROPOSED, never created by the stream

  const withStagePlugins = (names: string[], extra: Record<string, unknown> = {}) => ({
    project: 'app',
    organization: 'test',
    description: 'Pipeline with plugins',
    keywords: [],
    synth: { source: { type: 'github', options: { repo: 'test/app' } }, plugin: { name: 'cdk-synth' } },
    stages: [{ stageName: 'Build', steps: names.map((name) => ({ plugin: { name } })) }],
    ...extra,
  });
  const missingEvent = (res: any) => parseSseEvents(res.chunks).find((e: any) => e.type === 'missing-plugins') as any;

  it('emits checking-plugins and a missing-plugins proposal — and creates NOTHING', async () => {
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], withStagePlugins(['nodejs-build', 'docker-push'])));
    // findExistingPluginNames does ONE batched query, resolved via the thenable chain.
    mockDbChain.then.mockImplementationOnce((resolve: Function) => resolve([])); // both missing
    mockPluginClientPost.mockResolvedValue({ statusCode: 202, body: { data: { requestId: 'build-req-1' } } });

    const res = mockSseRes();
    await handler(mockReq(), res);
    const events = parseSseEvents(res.chunks);

    expect(events.find((e: any) => e.type === 'checking-plugins')).toEqual({
      type: 'checking-plugins',
      data: { plugins: ['nodejs-build', 'docker-push'] },
    });
    expect(missingEvent(res)).toEqual({
      type: 'missing-plugins',
      data: { existing: [], proposed: ['nodejs-build', 'docker-push'], refused: [] },
    });
    // A model's output never creates a plugin on its own.
    expect(events.find((e: any) => e.type === 'creating-plugins')).toBeUndefined();
    expect(mockPluginClientPost).not.toHaveBeenCalled();
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(auditRows()[0].details).toEqual(expect.objectContaining({ proposedPlugins: 2 }));
  });

  // A plugin name that isn't a strict `[a-z0-9-]+` token is shell/Dockerfile
  // injection bait — refused in the proposal, never offered for confirmation.
  it('refuses a shell-injection plugin name in the proposal', async () => {
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], withStagePlugins(['safe-plugin', '"; rm -rf / #'])));
    mockDbChain.then.mockImplementationOnce((resolve: Function) => resolve([]));

    const res = mockSseRes();
    await handler(mockReq(), res);

    expect(missingEvent(res).data).toEqual({
      existing: [],
      proposed: ['safe-plugin'],
      refused: [{ name: '"; rm -rf / #', error: 'invalid plugin name' }],
    });
  });

  it('proposes nothing when all referenced plugins already exist', async () => {
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], withStagePlugins(['nodejs-build', 'test-runner'])));
    mockDbChain.then.mockImplementationOnce((resolve: Function) =>
      resolve([{ name: 'nodejs-build' }, { name: 'test-runner' }]));

    const res = mockSseRes();
    await handler(mockReq(), res);

    expect(missingEvent(res).data).toEqual({ existing: ['nodejs-build', 'test-runner'], proposed: [], refused: [] });
    expect(mockPluginClientPost).not.toHaveBeenCalled();
  });

  it('never proposes a placeholder for a LISTED name, and counts an implicitly installed Official plugin as existing', async () => {
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], withStagePlugins(['trivy', 'terraform-plan', 'fresh'])));
    mockDbChain.then.mockImplementationOnce((resolve: Function) => resolve([]));
    // `trivy` resolves through the implicit Official install …
    mockResolvableListings.mockResolvedValueOnce([
      { publisher: { handle: 'pipeline-builder', tier: 'official' }, listing: { name: 'trivy', keywords: [], category: 'security', summary: null }, resolved: { version: '1.0.0', specSnapshot: {}, deprecatedAt: null } },
    ]);
    // … and `terraform-plan` is listed by acme but not installed.
    mockGenListingSource.liveListings.mockResolvedValueOnce([{ id: 'l-tf', publisherId: 'pub-a', name: 'terraform-plan' }]);
    mockGenListingSource.publishersByIds.mockResolvedValueOnce([{ id: 'pub-a', handle: 'acme' }]);

    const res = mockSseRes();
    await handler(mockReq(), res);

    const { data } = missingEvent(res);
    expect(data.existing).toEqual(['trivy']);
    expect(data.proposed).toEqual(['fresh']);
    expect(data.refused).toEqual([
      { name: 'terraform-plan', error: expect.stringMatching(/^PLUGIN_NAME_LISTED: "terraform-plan" is a listed plugin \(acme\/terraform-plan\)/) },
    ]);
    expect(mockPluginClientPost).not.toHaveBeenCalled();
  });

  it('deduplicates plugin names when the same plugin is referenced multiple times', async () => {
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], withStagePlugins(['nodejs-build', 'nodejs-build', 'docker-push', 'docker-push'])));
    mockDbChain.then.mockImplementationOnce((resolve: Function) =>
      resolve([{ name: 'nodejs-build' }, { name: 'docker-push' }]));

    const res = mockSseRes();
    await handler(mockReq(), res);

    expect(parseSseEvents(res.chunks).find((e: any) => e.type === 'checking-plugins')).toEqual({
      type: 'checking-plugins',
      data: { plugins: ['nodejs-build', 'docker-push'] },
    });
  });

  // Client abort: the slot follows provider contact, not the abort

  /** A request whose 'close' listener the test can fire mid-stream. */
  function closableReq() {
    let close: () => void = () => undefined;
    const req = mockReq({ on: jest.fn((event: string, cb: () => void) => { if (event === 'close') close = cb; }) });
    return { req, close: () => close() };
  }

  it('refunds the slot when the client leaves BEFORE the provider responded, and audits the abort', async () => {
    const { req, close } = closableReq();
    mockStreamPipelineConfig.mockImplementation(() => ({
      ...createMockStreamResult([]),
      partialOutputStream: (async function* () { close(); yield { project: 'x' }; })(),
    }));

    await handler(req, mockSseRes());

    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(auditRows()[0]).toEqual(expect.objectContaining({
      outcome: 'failure',
      details: expect.objectContaining({ aborted: true, quota: expect.objectContaining({ slot: 'refunded' }) }),
    }));
  });

  it('KEEPS the slot when the client leaves AFTER the provider responded', async () => {
    const { req, close } = closableReq();
    mockStreamPipelineConfig.mockImplementation((_request: unknown, call: { onProviderResponse: () => void }) => ({
      ...createMockStreamResult([]),
      partialOutputStream: (async function* () { call.onProviderResponse(); close(); yield { project: 'x' }; })(),
    }));

    await handler(req, mockSseRes());

    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(auditRows()[0].details.quota.slot).toBe('kept');
  });

  // No stages or no step-plugin references  auto-plugin skipped

  it('skips auto-plugin creation when output has no stages with steps', async () => {
    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      description: 'Simple pipeline',
      keywords: [],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputNoStages));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    // Should NOT have checking-plugins or missing-plugins events
    expect(events.find((e: any) => e.type === 'checking-plugins')).toBeUndefined();
    expect(events.find((e: any) => e.type === 'missing-plugins')).toBeUndefined();

    // Should still end correctly
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(res.end).toHaveBeenCalled();
  });

  // Streaming error after headers sent  SSE error event

  it('sends SSE error event when an error occurs after headers are sent', async () => {
    mockStreamPipelineConfig.mockImplementation(() => {
      throw new Error('AI provider not configured');
    });

    const req = mockReq();
    const res = mockSseRes();
    // Simulate headers already sent (after flushHeaders)
    Object.defineProperty(res, 'headersSent', { get: () => true });

    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    // Should have analyzing event
    expect(events[0]).toEqual({ type: 'analyzing' });

    // Should have analyzed event (analysis succeeded before the error)
    expect(events[1]).toEqual(expect.objectContaining({ type: 'analyzed' }));

    // Then error as SSE event (since headers already sent)
    const errorEvent = events.find((e: any) => e.type === 'error' && e.message?.includes('AI provider not configured'));
    expect(errorEvent).toBeDefined();
    expect(res.end).toHaveBeenCalled();
  });

  // Error before headers sent  returns HTTP error

  it('returns HTTP 500 when error occurs before headers are sent (provider not configured)', async () => {
    mockStreamPipelineConfig.mockImplementation(() => {
      throw new Error('AI generation is not configured for provider');
    });

    const req = mockReq();
    const res = mockSseRes();
    // headersSent stays false (default)
    await handler(req, res);

    // Since headersSent is false and message includes 'not configured',
    // it should call sendInternalError
    expect(mockSendInternalError).toHaveBeenCalledWith( res,
      'AI generation is not configured for the requested provider',
    );
  });

  it('returns HTTP 400 when error message indicates model not available for provider', async () => {
    mockStreamPipelineConfig.mockImplementation(() => {
      throw new Error('Model gpt-5 is not available for provider anthropic');
    });

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    expect(mockSendBadRequest).toHaveBeenCalledWith( res,
      'Model gpt-5 is not available for provider anthropic',
    );
  });

  it('returns generic HTTP 500 for other pre-header errors', async () => {
    mockStreamPipelineConfig.mockImplementation(() => {
      throw new Error('Unexpected internal error');
    });

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    expect(mockSendInternalError).toHaveBeenCalledWith( res,
      'Failed to generate pipeline from URL',
      { details: 'Unexpected internal error' },
    );
    // A failed generation is audited too, with the slot refunded (provider never responded).
    expect(auditRows()).toEqual([expect.objectContaining({
      outcome: 'failure',
      details: expect.objectContaining({ errorCode: 'Error', quota: expect.objectContaining({ slot: 'refunded' }) }),
    })]);
  });

  // repoToken passed to analyzeRepository

  it('passes repoToken to analyzeRepository when provided', async () => {
    mockValidateBody.mockReturnValue({
      ok: true,
      value: {
        gitUrl: 'https://github.com/test/app',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        repoToken: 'ghp_secret123',
      },
    });

    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputNoStages));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    expect(mockAnalyzeRepository).toHaveBeenCalledWith(VALID_PARSED_URL, 'ghp_secret123');
  });

  // apiKey passed to streamPipelineConfig

  it('resolves the model with the caller\'s own apiKey when provided', async () => {
    mockValidateBody.mockReturnValue({
      ok: true,
      value: {
        gitUrl: 'https://github.com/test/app',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        apiKey: 'sk-custom-key',
      },
    });

    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputNoStages));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    expect(mockResolveOrgModelSelection).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'test-org',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      apiKey: 'sk-custom-key',
    }));
  });

  // Null final output  done event not sent, but [DONE] still sent

  it('skips done event but sends [DONE] when AI returns null output', async () => {
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult( [{ project: 'app' }],
      null,
    ));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    // Should have analyzing, analyzed, partial events
    expect(events[0]).toEqual({ type: 'analyzing' });
    expect(events[1]).toEqual(expect.objectContaining({ type: 'analyzed' }));
    expect(events[2]).toEqual({ type: 'partial', data: { project: 'app' } });

    // Should NOT have a done event
    const doneEvent = events.find((e: any) => e.type === 'done');
    expect(doneEvent).toBeUndefined();

    // But should still have [DONE] sentinel
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(res.end).toHaveBeenCalled();

    // Quota policy: a COMPLETED stream KEEPS the reserved aiCalls slot even when
    // finalOutput is empty — the provider round-trip cost was incurred. No refund.
    // (generate-plugin.ts is aligned to this same policy.)
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  // Analyzed event includes correct subset of analysis fields

  it('includes only the specified analysis fields in the analyzed event', async () => {
    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputNoStages));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);
    const analyzedEvent = events.find((e: any) => e.type === 'analyzed') as any;

    expect(analyzedEvent.data).toEqual({
      owner: 'test',
      repo: 'app',
      provider: 'github',
      defaultBranch: 'main',
      projectType: 'nodejs',
      languages: { TypeScript: 70, JavaScript: 30 },
      frameworks: [],
      packageManager: 'npm',
      hasDockerfile: false,
      hasCdkJson: false,
      description: 'A test application',
    });

    // Should NOT include internal fields like detectedFiles, topics, host
    expect(analyzedEvent.data.detectedFiles).toBeUndefined();
    expect(analyzedEvent.data.topics).toBeUndefined();
    expect(analyzedEvent.data.host).toBeUndefined();
  });

  // req.on('close') is registered for abort detection

  it('registers a close handler on the request for abort detection', async () => {
    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputNoStages));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    expect(req.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  // FIX 1 — the aiCalls quota reserve must use a minted service token, NOT the
  // end-user bearer (the quota /increment endpoint rejects non-service principals
  // with 403, which would fail-close the feature for every non-admin).
  it('reserves aiCalls quota with a service token, not the user bearer', async () => {
    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      synth: { source: { type: 'github', options: { repo: 'test/app' } }, plugin: { name: 'nodejs-build' } },
    };
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputNoStages));

    const req = mockReq(); // headers.authorization = 'Bearer test-token'
    const res = mockSseRes();
    await handler(req, res);

    expect(mockReserveQuota).toHaveBeenCalledWith(
      expect.anything(), 'test-org', 'aiCalls', 'Bearer service-token', 1,
      expect.objectContaining({ feature: 'pipeline-generate', model: 'claude-sonnet-5', keySource: 'platform' }),
    );
    // The user's bearer must never be used as the quota principal.
    const usedUserBearer = mockReserveQuota.mock.calls.some((c: any[]) => c[3] === 'Bearer test-token');
    expect(usedUserBearer).toBe(false);
  });

  // FIX 3 — a gitUrl may embed credentials (https://user:token@host/...). The
  // request log must carry only the parsed host/owner/repo, never the raw URL.
  it('does not log the raw gitUrl (which can embed credentials)', async () => {
    mockValidateBody.mockReturnValue({
      ok: true,
      value: {
        gitUrl: 'https://user:s3cr3t-token@github.com/test/app',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    });
    // parseGitUrl strips creds — it yields only host/owner/repo/provider.
    mockParseGitUrl.mockReturnValue(VALID_PARSED_URL);

    const finalOutputNoStages = {
      project: 'app',
      organization: 'test',
      synth: { source: { type: 'github', options: { repo: 'test/app' } }, plugin: { name: 'nodejs-build' } },
    };
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputNoStages));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const loggedBlob = JSON.stringify(mockCtxLog.mock.calls);
    // No credentials and no raw credential-bearing URL anywhere in the logs.
    expect(loggedBlob).not.toContain('s3cr3t-token');
    expect(loggedBlob).not.toContain('user:');
    // The request-received log carries the safe parsed identity instead.
    const requestLog = mockCtxLog.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('from URL requested'),
    );
    expect(requestLog).toBeDefined();
    expect(requestLog?.[2]).toEqual(expect.objectContaining({ host: 'github.com', owner: 'test', repo: 'app' }));
    expect(requestLog?.[2]).not.toHaveProperty('gitUrl');
  });
});

// The aiCalls refund policy is keep-on-provider-contact for the
// NON-streaming /generate route (the streaming path already keeps the slot once
// the provider was contacted). An empty/unparseable output AFTER a completed
// provider round-trip (AIEmptyOutputError) must NOT refund; a pre-provider
// failure (model resolution, connectivity) must refund.
describe('POST /generate (aiCalls refund policy)', () => {
  const handler = getHandler('post', '/generate');

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({
      ok: true,
      value: { prompt: 'build a node app', provider: 'anthropic', model: 'claude-sonnet-5' },
    });
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', limit: 1000, used: 1, remaining: 999, resetAt: '2026-01-01T00:00:00Z' } });
  });

  it('KEEPS the reserved aiCalls slot when the provider round-trip completed but returned no usable output', async () => {
    mockGeneratePipelineConfig.mockRejectedValue(new AIEmptyOutputError());

    const req = mockReq({ body: {} });
    const res = mockSseRes();
    await handler(req, res);

    // Provider was contacted → no refund (matches the streaming path).
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('REFUNDS the reserved aiCalls slot on a pre-provider failure (model resolution / connectivity)', async () => {
    mockGeneratePipelineConfig.mockRejectedValue(new Error('AI provider "anthropic" is not configured'));

    const req = mockReq({ body: {} });
    const res = mockSseRes();
    await handler(req, res);

    // Provider never produced a round-trip → slot returned.
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
  });

  it('does not refund on a successful generation', async () => {
    mockGeneratePipelineConfig.mockResolvedValue({
      props: { project: 'app', organization: 'test' },
      description: 'desc',
      keywords: ['node'],
      usage: USAGE,
      servedBy: { provider: 'anthropic', model: 'claude-sonnet-5' },
      promptVersion: 'pipeline-generate@test',
    });

    const req = mockReq({ body: {} });
    const res = mockSseRes();
    await handler(req, res);

    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalled();
    expect(auditRows()).toEqual([expect.objectContaining({ outcome: 'success', details: expect.objectContaining({ route: 'generate', promptLength: 16 }) })]);
  });

  it('marks the slot consumed when the provider responds, so a later failure keeps it', async () => {
    mockGeneratePipelineConfig.mockImplementation(async (_request: unknown, call: { onProviderResponse: () => void }) => {
      call.onProviderResponse();
      throw new Error('stream broke mid-body');
    });

    await handler(mockReq({ body: {} }), mockSseRes());

    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(auditRows()[0]).toEqual(expect.objectContaining({ outcome: 'failure', details: expect.objectContaining({ quota: expect.objectContaining({ slot: 'kept' }) }) }));
  });

  it('records the AI_DISABLED refusal raised by model selection without charging the org', async () => {
    mockResolveOrgModelSelection.mockRejectedValueOnce(Object.assign(new Error('AI features are turned off for this organization.'), { code: 'AI_DISABLED', statusCode: 403 }));

    await handler(mockReq({ body: {} }), mockSseRes());

    expect(mockGeneratePipelineConfig).not.toHaveBeenCalled();
    // The model is resolved BEFORE the reservation now: nothing reserved, nothing to refund.
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    const row = auditRows()[0];
    expect(row.details).toEqual(expect.objectContaining({ errorCode: 'AI_DISABLED' }));
    expect(row.details).not.toHaveProperty('ai');
  });
});

// Non-streaming counterpart used by the Ask agent's propose_pipeline_from_repo
// tool: same analysis + generation, one JSON response, and NO side effects
// (drafts never auto-create plugins).
describe('POST /generate/from-url (JSON)', () => {
  const handler = getHandler('post', '/generate/from-url');

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({
      ok: true,
      value: { gitUrl: 'https://github.com/test/app', provider: 'anthropic', model: 'claude-sonnet-5', repoToken: 'ghp_secret' },
    });
    mockParseGitUrl.mockReturnValue(VALID_PARSED_URL);
    mockAnalyzeRepository.mockResolvedValue(MOCK_ANALYSIS);
    mockBuildEnhancedPrompt.mockReturnValue('Generated prompt for test/app');
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', limit: 1000, used: 1, remaining: 999, resetAt: '2026-01-01T00:00:00Z' } });
    mockGeneratePipelineConfig.mockResolvedValue({
      props: { project: 'app', organization: 'test', stages: [{ stageName: 'Build', steps: [{ plugin: { name: 'brand-new-plugin' } }] }] },
      description: 'desc',
      keywords: ['node'],
      usage: USAGE,
      servedBy: { provider: 'anthropic', model: 'claude-sonnet-5' },
      promptVersion: 'pipeline-generate@test',
    });
  });

  it('returns the generated config, keywords, and the analysis summary', async () => {
    const res = mockSseRes();
    await handler(mockReq({ body: {} }), res);

    expect(mockAnalyzeRepository).toHaveBeenCalledWith(VALID_PARSED_URL, 'ghp_secret');
    expect(mockGeneratePipelineConfig).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Generated prompt for test/app', orgId: 'test-org' }),
      expect.objectContaining({ selection: SELECTION }),
    );
    const data = mockSendSuccess.mock.calls[0][2] as { props: unknown; keywords: string[]; analysis: Record<string, unknown> };
    expect(data.keywords).toEqual(['node']);
    expect(data.analysis).toEqual(expect.objectContaining({ owner: MOCK_ANALYSIS.owner, repo: MOCK_ANALYSIS.repo }));
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('never auto-creates missing plugins (drafts have no side effects)', async () => {
    await handler(mockReq({ body: {} }), mockSseRes());
    expect(mockPluginClientPost).not.toHaveBeenCalled();
  });

  it('refunds the slot and 400s when repository analysis fails', async () => {
    mockAnalyzeRepository.mockRejectedValue(new Error('Repository not found'));
    const res = mockSseRes();
    await handler(mockReq({ body: {} }), res);

    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'Repository analysis failed: Repository not found');
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockGeneratePipelineConfig).not.toHaveBeenCalled();
    expect(auditRows()[0]).toEqual(expect.objectContaining({ outcome: 'failure', details: expect.objectContaining({ analysisFailed: true }) }));
  });

  it('400s an unparseable Git URL before reserving quota', async () => {
    mockParseGitUrl.mockReturnValue(null);
    await handler(mockReq({ body: {} }), mockSseRes());
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockReserveQuota).not.toHaveBeenCalled();
  });
});

// The explicit follow-up to a `missing-plugins` proposal: only names the USER
// confirmed are created, each re-checked server-side and deployed AS THE USER.
describe('POST /generate/missing-plugins (confirmed placeholder creation)', () => {
  const handler = getHandler('post', '/generate/missing-plugins');
  const confirm = (plugins: string[]) => mockValidateBody.mockReturnValue({ ok: true, value: { plugins } });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbChain.then.mockImplementation((resolve: Function) => resolve([]));
  });

  it('creates only the confirmed names that are still missing, forwarding the user\'s bearer', async () => {
    confirm(['nodejs-build', 'new-plugin']);
    mockDbChain.then.mockImplementationOnce((resolve: Function) => resolve([{ name: 'nodejs-build' }]));
    mockPluginClientPost.mockResolvedValue({ statusCode: 202, body: { data: { requestId: 'deploy-req-42' } } });

    const res = mockSseRes();
    await handler(mockReq({ body: {} }), res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      created: ['new-plugin'],
      existing: ['nodejs-build'],
      builds: [{ name: 'new-plugin', requestId: 'deploy-req-42' }],
    });
    expect(mockPluginClientPost).toHaveBeenCalledTimes(1);
    expect(mockPluginClientPost).toHaveBeenCalledWith('/plugins/deploy-generated',
      expect.objectContaining({ name: 'new-plugin', version: '1.0.0', pluginType: 'CodeBuildStep', computeType: 'MEDIUM', visibility: 'private' }),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer test-token', 'x-org-id': 'test-org', 'x-request-id': 'test-req-id' }),
      }),
    );
    // No AI call and no aiCalls slot.
    expect(mockReserveQuota).not.toHaveBeenCalled();
  });

  it('re-validates names server-side: an unsafe name sent by the client is refused, never deployed', async () => {
    confirm(['safe-plugin', '"; rm -rf / #']);
    mockPluginClientPost.mockResolvedValue({ statusCode: 202, body: { data: { requestId: 'deploy-safe' } } });

    await handler(mockReq({ body: {} }), mockSseRes());

    const data = mockSendSuccess.mock.calls[0][2] as { builds: unknown[] };
    expect(data.builds).toEqual(expect.arrayContaining([
      { name: 'safe-plugin', requestId: 'deploy-safe' },
      { name: '"; rm -rf / #', error: 'invalid plugin name' },
    ]));
    expect(mockPluginClientPost).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockPluginClientPost.mock.calls)).not.toContain('rm -rf');
  });

  it('records a deploy failure per plugin — and never reports a failed build as created', async () => {
    confirm(['failing-plugin']);
    mockPluginClientPost.mockRejectedValue(new Error('Connection refused'));

    await handler(mockReq({ body: {} }), mockSseRes());

    expect(mockSendSuccess.mock.calls[0][2]).toEqual({ created: [], existing: [], builds: [{ name: 'failing-plugin', error: 'Connection refused' }] });
  });

  it('records an HTTP error when the plugin service answers non-success', async () => {
    confirm(['bad-plugin']);
    mockPluginClientPost.mockResolvedValue({ statusCode: 500, body: { message: 'Internal error' } });

    await handler(mockReq({ body: {} }), mockSseRes());

    expect((mockSendSuccess.mock.calls[0][2] as any).builds).toEqual([{ name: 'bad-plugin', error: 'HTTP 500' }]);
    expect((mockSendSuccess.mock.calls[0][2] as any).created).toEqual([]);
  });

  it('400s an invalid body', async () => {
    mockValidateBody.mockReturnValue({ ok: false, error: 'plugins is required' });
    await handler(mockReq({ body: {} }), mockSseRes());
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockPluginClientPost).not.toHaveBeenCalled();
  });
});

describe('pipeline-generate burst limiter', () => {
  it('is ONE limiter instance shared by every /generate* route', () => {
    const generateCalls = limiterCalls.filter((c) => c.opts.name === 'pipeline-generate');
    expect(generateCalls).toHaveLength(1);

    const limiter = generateCalls[0].limiter;
    for (const path of ['/generate', '/generate/stream', '/generate/from-url', '/generate/from-url/stream']) {
      const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods.post);
      expect(layer.route.stack.map((l: any) => l.handle)).toContain(limiter);
    }
  });
});

// The AI-free analysis behind the Ask agent's propose_plugin_from_repo: no model
// call, no aiCalls slot (it used to run a whole generation to keep `analysis`).
describe('POST /analyze/from-url (analysis only)', () => {
  const handler = getHandler('post', '/analyze/from-url');

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({ ok: true, value: { gitUrl: 'https://github.com/test/app', repoToken: 'ghp_secret' } });
    mockParseGitUrl.mockReturnValue(VALID_PARSED_URL);
    mockAnalyzeRepository.mockResolvedValue(MOCK_ANALYSIS);
  });

  it('returns the analysis summary — no model resolved, no aiCalls reserved, nothing generated', async () => {
    const res = mockSseRes();
    await handler(mockReq({ body: {} }), res);
    expect(mockAnalyzeRepository).toHaveBeenCalledWith(VALID_PARSED_URL, 'ghp_secret');
    expect(mockResolveOrgModelSelection).not.toHaveBeenCalled();
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockGeneratePipelineConfig).not.toHaveBeenCalled();
    const data = mockSendSuccess.mock.calls[0][2] as { analysis: Record<string, unknown> };
    expect(data.analysis).toEqual(expect.objectContaining({ owner: MOCK_ANALYSIS.owner, repo: MOCK_ANALYSIS.repo }));
  });

  it('400s on an unparseable URL and on a failed analysis', async () => {
    mockParseGitUrl.mockReturnValueOnce(null);
    await handler(mockReq({ body: {} }), mockSseRes());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Invalid Git URL'));
    mockAnalyzeRepository.mockRejectedValueOnce(new Error('404 repo'));
    await handler(mockReq({ body: {} }), mockSseRes());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Repository analysis failed'));
    expect(mockReserveQuota).not.toHaveBeenCalled();
  });

  it('400s on an invalid body', async () => {
    mockValidateBody.mockReturnValueOnce({ ok: false, error: 'gitUrl is required' });
    const res = mockSseRes();
    await handler(mockReq({ body: {} }), res);
    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'gitUrl is required');
  });
});

describe('POST /generate/from-url (JSON) — BYOK spends no aiCalls unit', () => {
  const handler = getHandler('post', '/generate/from-url');

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBody.mockReturnValue({ ok: true, value: { gitUrl: 'https://github.com/test/app', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-own' } });
    mockParseGitUrl.mockReturnValue(VALID_PARSED_URL);
    mockAnalyzeRepository.mockResolvedValue(MOCK_ANALYSIS);
    mockBuildEnhancedPrompt.mockReturnValue('prompt');
    mockGeneratePipelineConfig.mockResolvedValue({
      props: { project: 'app', organization: 'test' }, description: 'd', keywords: [], usage: USAGE, servedBy: { provider: 'anthropic', model: 'claude-sonnet-5' }, promptVersion: 'p',
    });
  });

  it('a request (or org) key reserves nothing and audits the slot as waived', async () => {
    mockResolveOrgModelSelection.mockResolvedValueOnce({ ...SELECTION, keySource: 'request' });
    await handler(mockReq({ body: {} }), mockSseRes());
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockGeneratePipelineConfig).toHaveBeenCalled();
    expect(auditRows()[0].details).toEqual(expect.objectContaining({ quota: { type: 'aiCalls', slot: 'waived', waived: 'byok', amount: 0 } }));
  });
});
