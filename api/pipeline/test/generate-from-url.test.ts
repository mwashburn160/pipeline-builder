/**
 * Integration tests for the POST /generate/from-url/stream route.
 * Tests the full SSE streaming pipeline: URL parsing -> repo analysis ->
 * AI generation -> auto-plugin creation.
 *
 * @module test/generate-from-url
 */

// ---------------------------------------------------------------------------
// Mock function references — must be defined before jest.mock() calls
// ---------------------------------------------------------------------------

const mockParseGitUrl = jest.fn();
const mockAnalyzeRepository = jest.fn();
const mockBuildEnhancedPrompt = jest.fn();
const mockStreamPipelineConfig = jest.fn();
const mockGetAvailableProviders = jest.fn();
const mockValidateBody = jest.fn();
const mockSendBadRequest = jest.fn();
const mockSendInternalError = jest.fn();
const mockSendSuccess = jest.fn();
const mockCreateSafeClient = jest.fn();
const mockPluginClientPost = jest.fn();
const mockDbSelect = jest.fn();

// ---------------------------------------------------------------------------
// Mocks — must be defined before imports
// ---------------------------------------------------------------------------

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
  createSafeClient: (...args: any[]) => {
    mockCreateSafeClient(...args);
    return { post: mockPluginClientPost };
  },
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
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
}));

jest.mock('@mwashburn160/api-server', () => ({
  createAuthenticatedWithOrgRoute: () => [],
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = {
      identity: { orgId: req.context?.identity?.orgId || 'test-org' },
      log: jest.fn(),
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
jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_col: any, _val: any) => ({ type: 'eq', col: _col, val: _val })),
  or: jest.fn((...args: any[]) => ({ type: 'or', args })),
  and: jest.fn((...args: any[]) => ({ type: 'and', args })),
  isNull: jest.fn((_col: any) => ({ type: 'isNull', col: _col })),
}));

const mockDbChain = {
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
};

jest.mock('@mwashburn160/pipeline-core', () => ({
  db: {
    select: (...args: any[]) => {
      mockDbSelect(...args);
      return mockDbChain;
    },
  },
  schema: {
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
      accessModifier: 'accessModifier',
    },
  },
}));

jest.mock('../src/services/git-analysis-service', () => ({
  parseGitUrl: mockParseGitUrl,
  analyzeRepository: mockAnalyzeRepository,
  buildEnhancedPrompt: mockBuildEnhancedPrompt,
}));

jest.mock('../src/services/ai-generation-service', () => ({
  getAvailableProviders: mockGetAvailableProviders,
  streamPipelineConfig: mockStreamPipelineConfig,
  generatePipelineConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { createGeneratePipelineRoutes } from '../src/routes/generate-pipeline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const router = createGeneratePipelineRoutes();

/**
 * Extract a route handler from the Express router by method and path.
 * Returns the LAST handler in the route stack (the actual handler, after any middleware).
 */
function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
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
      model: 'claude-sonnet-4-20250514',
    },
    headers: { authorization: 'Bearer test-token' },
    context: {
      identity: { orgId: 'TEST-ORG' },
      log: jest.fn(),
      requestId: 'test-req-id',
    },
    on: jest.fn(),
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
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  res.setTimeout = jest.fn();
  res.flushHeaders = jest.fn();
  res.write = jest.fn((chunk: string) => { chunks.push(chunk); return true; });
  res.end = jest.fn();
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

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

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

/**
 * Create a mock streamPipelineConfig result with an async generator
 * for partialOutputStream and a Promise for output.
 */
function createMockStreamResult(
  partials: Record<string, unknown>[],
  finalOutput: Record<string, unknown> | null = MOCK_FINAL_OUTPUT,
) {
  async function* generate() {
    for (const partial of partials) {
      yield partial;
    }
  }
  return {
    partialOutputStream: generate(),
    output: Promise.resolve(finalOutput),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
        model: 'claude-sonnet-4-20250514',
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

  // -------------------------------------------------------------------------
  // Happy path — full streaming flow
  // -------------------------------------------------------------------------

  it('streams analyzing -> analyzed -> partial -> done -> [DONE] for a valid GitHub URL', async () => {
    const partials = [
      { project: 'app' },
      { project: 'app', organization: 'test' },
      { project: 'app', organization: 'test', synth: { source: { type: 'github' } } },
    ];

    // Final output has no stages with pluginName actions, so autoCreateMissingPlugins
    // will extract no plugin names and skip the plugin creation flow
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

    // Event 2: analyzed — repo analysis data
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
    expect(mockStreamPipelineConfig).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Generated prompt for test/app',
      orgId: 'test-org',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    }));
  });

  // -------------------------------------------------------------------------
  // Validation failures
  // -------------------------------------------------------------------------

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
        model: 'claude-sonnet-4-20250514',
      },
    });
    mockParseGitUrl.mockReturnValue(null);

    const req = mockReq({ body: { gitUrl: 'not-a-valid-url', provider: 'anthropic', model: 'claude-sonnet-4-20250514' } });
    const res = mockSseRes();
    await handler(req, res);

    expect(mockSendBadRequest).toHaveBeenCalledWith(
      res,
      'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.',
    );
    expect(res.write).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Repository analysis failure
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Auto-plugin creation — missing plugins
  // -------------------------------------------------------------------------

  it('emits checking-plugins and creating-plugins events for missing plugins', async () => {
    // Final output references plugins via stages[].steps[].plugin.name
    // But extractPluginNames looks at stages[].actions[].pluginName
    // Let's match the actual code: stages[].actions[].pluginName
    const finalOutputWithActions = {
      project: 'app',
      organization: 'test',
      description: 'Pipeline with plugins',
      keywords: ['test'],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
      stages: [
        {
          stageName: 'Build',
          actions: [
            { pluginName: 'nodejs-build' },
            { pluginName: 'docker-push' },
          ],
        },
      ],
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputWithActions));

    // DB lookup for plugin existence:
    // Note: getAvailablePlugins does NOT call .limit(), only autoCreateMissingPlugins does
    mockDbChain.limit
      .mockResolvedValueOnce([]) // nodejs-build check — missing
      .mockResolvedValueOnce([]); // docker-push check — missing

    // Plugin service deploy returns 202
    mockPluginClientPost.mockResolvedValue({
      statusCode: 202,
      body: { data: { requestId: 'build-req-1' } },
    });

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    // Find the checking-plugins event
    const checkingEvent = events.find((e: any) => e.type === 'checking-plugins');
    expect(checkingEvent).toEqual({
      type: 'checking-plugins',
      data: { plugins: ['nodejs-build', 'docker-push'] },
    });

    // Find the creating-plugins event
    const creatingEvent = events.find((e: any) => e.type === 'creating-plugins');
    expect(creatingEvent).toEqual({
      type: 'creating-plugins',
      data: {
        creating: ['nodejs-build', 'docker-push'],
        existing: [],
        builds: [
          { name: 'nodejs-build', requestId: 'build-req-1' },
          { name: 'docker-push', requestId: 'build-req-1' },
        ],
      },
    });

    // Should still have [DONE] at the end
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(res.end).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Auto-plugin creation — existing plugins skip creation
  // -------------------------------------------------------------------------

  it('skips plugin creation when all referenced plugins already exist', async () => {
    const finalOutputWithActions = {
      project: 'app',
      organization: 'test',
      description: 'Pipeline',
      keywords: [],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
      stages: [
        {
          stageName: 'Build',
          actions: [
            { pluginName: 'nodejs-build' },
            { pluginName: 'test-runner' },
          ],
        },
      ],
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputWithActions));

    // DB lookup: both plugins exist
    // Note: getAvailablePlugins does NOT call .limit(), only autoCreateMissingPlugins does
    mockDbChain.limit
      .mockResolvedValueOnce([{ name: 'nodejs-build' }]) // nodejs-build found
      .mockResolvedValueOnce([{ name: 'test-runner' }]); // test-runner found

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    // checking-plugins should list both
    const checkingEvent = events.find((e: any) => e.type === 'checking-plugins');
    expect(checkingEvent).toEqual({
      type: 'checking-plugins',
      data: { plugins: ['nodejs-build', 'test-runner'] },
    });

    // creating-plugins should show empty creating and both in existing
    const creatingEvent = events.find((e: any) => e.type === 'creating-plugins');
    expect(creatingEvent).toEqual({
      type: 'creating-plugins',
      data: {
        creating: [],
        existing: ['nodejs-build', 'test-runner'],
        builds: [],
      },
    });

    // Plugin service should NOT have been called
    expect(mockPluginClientPost).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Auto-plugin creation — mixed existing and missing
  // -------------------------------------------------------------------------

  it('creates only missing plugins when some already exist', async () => {
    const finalOutputWithActions = {
      project: 'app',
      organization: 'test',
      description: 'Mixed pipeline',
      keywords: [],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
      stages: [
        {
          stageName: 'Build',
          actions: [
            { pluginName: 'nodejs-build' },
            { pluginName: 'new-plugin' },
          ],
        },
      ],
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputWithActions));

    // DB lookup: nodejs-build exists, new-plugin does not
    // Note: getAvailablePlugins does NOT call .limit(), only autoCreateMissingPlugins does
    mockDbChain.limit
      .mockResolvedValueOnce([{ name: 'nodejs-build' }]) // nodejs-build found
      .mockResolvedValueOnce([]); // new-plugin not found

    mockPluginClientPost.mockResolvedValue({
      statusCode: 202,
      body: { data: { requestId: 'deploy-req-42' } },
    });

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    const creatingEvent = events.find((e: any) => e.type === 'creating-plugins');
    expect(creatingEvent).toEqual({
      type: 'creating-plugins',
      data: {
        creating: ['new-plugin'],
        existing: ['nodejs-build'],
        builds: [
          { name: 'new-plugin', requestId: 'deploy-req-42' },
        ],
      },
    });

    // Only called once for the missing plugin
    expect(mockPluginClientPost).toHaveBeenCalledTimes(1);
    expect(mockPluginClientPost).toHaveBeenCalledWith(
      '/plugins/deploy-generated',
      expect.objectContaining({
        name: 'new-plugin',
        version: '1.0.0',
        pluginType: 'CodeBuildStep',
        computeType: 'MEDIUM',
        accessModifier: 'private',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token',
          'x-org-id': 'test-org',
          'x-request-id': 'test-req-id',
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Auto-plugin creation — deploy failure records error
  // -------------------------------------------------------------------------

  it('records error in builds when plugin deployment fails', async () => {
    const finalOutputWithActions = {
      project: 'app',
      organization: 'test',
      description: 'Deploy fail test',
      keywords: [],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
      stages: [
        {
          stageName: 'Build',
          actions: [{ pluginName: 'failing-plugin' }],
        },
      ],
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputWithActions));

    // Note: getAvailablePlugins does NOT call .limit(), only autoCreateMissingPlugins does
    mockDbChain.limit
      .mockResolvedValueOnce([]); // failing-plugin not found

    mockPluginClientPost.mockRejectedValue(new Error('Connection refused'));

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    const creatingEvent = events.find((e: any) => e.type === 'creating-plugins');
    expect(creatingEvent).toEqual({
      type: 'creating-plugins',
      data: {
        creating: ['failing-plugin'],
        existing: [],
        builds: [
          { name: 'failing-plugin', error: 'Connection refused' },
        ],
      },
    });

    // Stream still completes normally
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(res.end).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Auto-plugin creation — non-202 status records HTTP error
  // -------------------------------------------------------------------------

  it('records HTTP error when plugin service returns non-success status', async () => {
    const finalOutputWithActions = {
      project: 'app',
      organization: 'test',
      description: 'HTTP error test',
      keywords: [],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
      stages: [
        {
          stageName: 'Build',
          actions: [{ pluginName: 'bad-plugin' }],
        },
      ],
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputWithActions));

    // Note: getAvailablePlugins does NOT call .limit(), only autoCreateMissingPlugins does
    mockDbChain.limit
      .mockResolvedValueOnce([]); // bad-plugin not found

    mockPluginClientPost.mockResolvedValue({
      statusCode: 500,
      body: { message: 'Internal error' },
    });

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    const creatingEvent = events.find((e: any) => e.type === 'creating-plugins');
    expect(creatingEvent).toEqual({
      type: 'creating-plugins',
      data: {
        creating: ['bad-plugin'],
        existing: [],
        builds: [
          { name: 'bad-plugin', error: 'HTTP 500' },
        ],
      },
    });
  });

  // -------------------------------------------------------------------------
  // No stages or no pluginName references — auto-plugin skipped
  // -------------------------------------------------------------------------

  it('skips auto-plugin creation when output has no stages with actions', async () => {
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

    // Should NOT have checking-plugins or creating-plugins events
    const checkingEvent = events.find((e: any) => e.type === 'checking-plugins');
    expect(checkingEvent).toBeUndefined();

    const creatingEvent = events.find((e: any) => e.type === 'creating-plugins');
    expect(creatingEvent).toBeUndefined();

    // Should still end correctly
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(res.end).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Streaming error after headers sent — SSE error event
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Error before headers sent — returns HTTP error
  // -------------------------------------------------------------------------

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
    expect(mockSendInternalError).toHaveBeenCalledWith(
      res,
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

    expect(mockSendBadRequest).toHaveBeenCalledWith(
      res,
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

    expect(mockSendInternalError).toHaveBeenCalledWith(
      res,
      'Failed to generate pipeline from URL',
    );
  });

  // -------------------------------------------------------------------------
  // repoToken passed to analyzeRepository
  // -------------------------------------------------------------------------

  it('passes repoToken to analyzeRepository when provided', async () => {
    mockValidateBody.mockReturnValue({
      ok: true,
      value: {
        gitUrl: 'https://github.com/test/app',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
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

  // -------------------------------------------------------------------------
  // apiKey passed to streamPipelineConfig
  // -------------------------------------------------------------------------

  it('passes apiKey to streamPipelineConfig when provided', async () => {
    mockValidateBody.mockReturnValue({
      ok: true,
      value: {
        gitUrl: 'https://github.com/test/app',
        provider: 'openai',
        model: 'gpt-4o',
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

    expect(mockStreamPipelineConfig).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-custom-key',
    }));
  });

  // -------------------------------------------------------------------------
  // Null final output — done event not sent, but [DONE] still sent
  // -------------------------------------------------------------------------

  it('skips done event but sends [DONE] when AI returns null output', async () => {
    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult(
      [{ project: 'app' }],
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
  });

  // -------------------------------------------------------------------------
  // Deduplication of plugin names from extractPluginNames
  // -------------------------------------------------------------------------

  it('deduplicates plugin names when the same plugin is referenced multiple times', async () => {
    const finalOutputDuplicatePlugins = {
      project: 'app',
      organization: 'test',
      description: 'Dedup test',
      keywords: [],
      synth: {
        source: { type: 'github', options: { repo: 'test/app' } },
        plugin: { name: 'nodejs-build' },
      },
      stages: [
        {
          stageName: 'Build',
          actions: [
            { pluginName: 'nodejs-build' },
            { pluginName: 'nodejs-build' },
            { pluginName: 'docker-push' },
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            { pluginName: 'docker-push' },
          ],
        },
      ],
    };

    mockStreamPipelineConfig.mockReturnValue(createMockStreamResult([], finalOutputDuplicatePlugins));

    // Note: getAvailablePlugins does NOT call .limit(), only autoCreateMissingPlugins does
    mockDbChain.limit
      .mockResolvedValueOnce([{ name: 'nodejs-build' }]) // nodejs-build found
      .mockResolvedValueOnce([{ name: 'docker-push' }]); // docker-push found

    const req = mockReq();
    const res = mockSseRes();
    await handler(req, res);

    const events = parseSseEvents(res.chunks);

    // checking-plugins should have deduplicated list
    const checkingEvent = events.find((e: any) => e.type === 'checking-plugins');
    expect(checkingEvent).toEqual({
      type: 'checking-plugins',
      data: { plugins: ['nodejs-build', 'docker-push'] },
    });
  });

  // -------------------------------------------------------------------------
  // Analyzed event includes correct subset of analysis fields
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // req.on('close') is registered for abort detection
  // -------------------------------------------------------------------------

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
});
