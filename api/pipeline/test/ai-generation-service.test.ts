// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock external dependencies — must be set up before importing the service

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { doublePrecision, integer, PgDialect, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGenerateText = jest.fn<(...args: any[]) => any>();
const mockStreamText = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('ai', () => ({
  generateText: mockGenerateText,
  streamText: mockStreamText,
  Output: {
    object: jest.fn((opts: any) => ({ type: 'object', schema: opts.schema })),
  },
  tool: (def: unknown) => def,
  generateObject: jest.fn(),
  stepCountIs: jest.fn((n: number) => n),
}));

jest.unstable_mockModule('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'amazon-bedrock', modelId }))),
}));
jest.unstable_mockModule('@ai-sdk/anthropic', () => ({
  createAnthropic: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'anthropic', modelId }))),
}));
jest.unstable_mockModule('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'openai', modelId }))),
}));
jest.unstable_mockModule('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'google', modelId }))),
}));
jest.unstable_mockModule('@ai-sdk/xai', () => ({
  createXai: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'xai', modelId }))),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => {
  class ValidationError extends Error {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    constructor(message: string) { super(message); this.name = 'ValidationError'; }
  }
  return apiCoreMock({
    ValidationError,
    AI_PROVIDER_CATALOG: {
      'anthropic': {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 4' },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
        ],
      },
      'openai': {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
        ],
      },
      'google': {
        id: 'google',
        name: 'Google',
        models: [
          { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
        ],
      },
      'xai': {
        id: 'xai',
        name: 'xAI (Grok)',
        models: [
          { id: 'grok-4.6', name: 'Grok 4.6' },
        ],
      },
      'amazon-bedrock': {
        id: 'amazon-bedrock',
        name: 'Amazon Bedrock',
        models: [
          { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5' },
        ],
      },
    },
    AI_PROVIDER_ENV_VARS: {
      'anthropic': 'ANTHROPIC_API_KEY',
      'openai': 'OPENAI_API_KEY',
      'google': 'GOOGLE_GENERATIVE_AI_API_KEY',
      'xai': 'XAI_API_KEY',
      'amazon-bedrock': 'AWS_ACCESS_KEY_ID',
    },
    getAIProviderModels: jest.fn((id: string) => {
      const catalog: Record<string, any[]> = {
        'anthropic': [
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 4' },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
        ],
        'openai': [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
        'google': [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }],
        'xai': [{ id: 'grok-4.6', name: 'Grok 4.6' }],
        'amazon-bedrock': [{ id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5' }],
      };
      return catalog[id] ?? [];
    }),
  });
});

// A real (minimal) plugins table so the AI context's WHERE can be rendered.
const aiPluginTable = pgTable('plugins', {
  name: varchar('name'),
  deletedAt: timestamp('deleted_at'),
  deprecatedAt: timestamp('deprecated_at'),
  yankedAt: timestamp('yanked_at'),
  lifecycle: varchar('lifecycle'),
});
const aiStatsTable = pgTable('plugin_stats', {
  listingId: varchar('listing_id'),
  ratingBayes: doublePrecision('rating_bayes'),
  ratingCount: integer('rating_count'),
  healthScore: doublePrecision('health_score'),
});
const aiPluginTx = { select: jest.fn().mockReturnThis(), from: jest.fn().mockReturnThis(), where: jest.fn<(...a: any[]) => any>().mockResolvedValue([]) };

const mockResolvableListings = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  // Plugin reads now run through withTenantTx (RLS-safe); the tx exposes the
  // same chaining select/from/where as the legacy bare db.
  const tx = aiPluginTx;
  return stubModule('@pipeline-builder/pipeline-data', {
    db: tx,
    schema: { plugin: aiPluginTable, pluginStats: aiStatsTable },
    withTenantTx: (fn: (t: typeof tx) => unknown) => fn(tx),
    // Visibility-ladder predicate pieces plugin-lookup-service links against.
    // Listing resolution (plugin ecosystem W2): no listings unless a test sets some.
    OFFICIAL_PUBLISHER_HANDLE: 'pipeline-builder',
    drizzleListingSource: () => ({ liveListings: async () => [], publishersByIds: async () => [] }),
    getTenantContext: () => undefined,
    runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
    resolvableListings: (...a: unknown[]) => mockResolvableListings(...a),
    buildPluginConditions: () => [],
    withViewerContext: (f: unknown) => f,
  });
});

// Import AFTER mocks

const {
  getAvailableProviders,
  getProviderModels,
  generatePipelineConfig,
  streamPipelineConfig,
  getFilteredPlugins,
  rankPlugins,
} = await import('../src/services/ai-generation-service.js');
type GenerationRequest = import('../src/services/ai-generation-service.js').GenerationRequest;

// Tests

describe('AI plugin selection lifecycle (plugin-ecosystem W0.4)', () => {
  it('never offers a deprecated or yanked plugin version', async () => {
    aiPluginTx.where.mockClear();
    await getFilteredPlugins('org-1', { prompt: '' });
    const where = aiPluginTx.where.mock.calls[0]![0];
    const { sql, params } = new PgDialect().sqlToQuery(where as never);
    expect(sql).toContain('"plugins"."deleted_at" is null');
    expect(sql).toContain('"plugins"."deprecated_at" is null');
    expect(sql).toContain('"plugins"."yanked_at" is null');
    expect(sql).toMatch(/"plugins"\."lifecycle" not in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['deprecated', 'yanked']));
  });
});

describe('AI plugin selection includes installed listings (plugin ecosystem G17)', () => {
  const state = (handle: string, name: string, over: Record<string, unknown> = {}) => ({
    publisher: { handle, tier: handle === 'pipeline-builder' ? 'official' : 'verified' },
    listing: { name, keywords: ['scan'], category: 'security', summary: `${name} summary` },
    resolved: { version: '1.2.0', deprecatedAt: null, specSnapshot: { pluginType: 'CodeBuildStep', computeType: 'MEDIUM', commands: ['run', 7], env: { A: '1' }, metadata: [] } },
    ...over,
  });

  it('offers Official listings by bare name, qualifies other publishers and shadowed Official ones, and hides deprecated versions', async () => {
    aiPluginTx.where.mockResolvedValueOnce([{ name: 'trivy', version: '0.1.0', pluginType: 'CodeBuildStep', computeType: 'SMALL', keywords: [], category: 'security', metadata: {}, env: {}, commands: [], installCommands: [], description: 'own' }]);
    mockResolvableListings.mockResolvedValueOnce([
      state('pipeline-builder', 'semgrep'),
      state('pipeline-builder', 'trivy'),
      state('acme', 'lint', { resolved: { version: '2.0.0', deprecatedAt: null, specSnapshot: { description: 'Lints' } } }),
      state('acme', 'old', { resolved: { version: '1.0.0', deprecatedAt: new Date(), specSnapshot: {} } }),
    ]);
    const plugins = await getFilteredPlugins('org-1', { prompt: '' });
    expect(plugins.map((p) => [p.publisher ?? null, p.name])).toEqual([[null, 'trivy'], [null, 'semgrep'], ['pipeline-builder', 'trivy'], ['acme', 'lint']]);
    expect(plugins[1]).toMatchObject({ version: '1.2.0', computeType: 'MEDIUM', commands: ['run'], env: { A: '1' }, metadata: {}, description: 'semgrep summary' });
    expect(plugins[3]).toMatchObject({ pluginType: 'CodeBuildStep', computeType: 'SMALL', description: 'Lints' });
  });
});

describe('AI plugin ranking by trust and health (plugin ecosystem W7)', () => {
  it('orders own → Official → Verified → others, active before paused/unmaintained, then by health', () => {
    const p = (name: string, tier: any, healthScore: number | null, lifecycle: any = 'active') => ({ name, tier, healthScore, lifecycle });
    const ranked = rankPlugins([
      p('c-low', 'community', 40),
      p('v-null', 'verified', null),
      p('o-90', 'official', 90),
      p('v-80', 'verified', 80),
      p('own', 'own', null),
      p('o-paused', 'official', 99, 'paused'),
      p('o-95', 'official', 95),
      p('u-99', 'unverified', 99),
      p('c-high', 'community', 70),
    ]);
    expect(ranked.map((x) => x.name)).toEqual(['own', 'o-95', 'o-90', 'o-paused', 'v-80', 'v-null', 'c-high', 'c-low', 'u-99']);
  });

  it('carries tier, rating, health and lifecycle onto listings, ranks them, and tags them in the prompt', async () => {
    aiPluginTx.where.mockResolvedValueOnce([
      { orgId: 'org-1', name: 'mine', version: '0.1.0', pluginType: 'CodeBuildStep', computeType: 'SMALL', keywords: [], category: 'security', metadata: {}, env: {}, commands: [], installCommands: [], description: 'own' },
      { orgId: '000000000000000000000001', name: 'fmt', version: '1.0.0', pluginType: 'CodeBuildStep', computeType: 'SMALL', keywords: [], category: 'quality', metadata: {}, env: {}, commands: [], installCommands: [], description: 'catalog' },
    ]);
    const listing = (handle: string, tier: string, name: string, listingOver: Record<string, unknown> = {}) => ({
      publisher: { handle, tier },
      listing: { id: `id-${name}`, name, keywords: [], category: 'security', summary: name, state: 'listed', pausedAt: null, ...listingOver },
      resolved: { version: '1.0.0', deprecatedAt: null, specSnapshot: {} },
    });
    mockResolvableListings.mockResolvedValueOnce([
      listing('someone', 'community', 'scan-c'),
      listing('acme', 'verified', 'scan-v', { pausedAt: new Date() }),
      listing('pipeline-builder', 'official', 'scan-o'),
      listing('beta', 'verified', 'scan-v2', { state: 'unmaintained' }),
    ]);
    // The plugin_stats read (after the rows read).
    aiPluginTx.where.mockResolvedValueOnce([
      { listingId: 'id-scan-o', ratingBayes: 4.456, ratingCount: 9, healthScore: 91.6 },
      { listingId: 'id-scan-c', ratingBayes: null, ratingCount: 0, healthScore: 55 },
    ]);
    const plugins = await getFilteredPlugins('org-1', { prompt: '' });
    // Official: the scored listing ahead of the unscored catalog row. Paused and unmaintained Verified
    // listings are both winding down, so (no health) they keep catalog order.
    expect(plugins.map((p) => p.name)).toEqual(['mine', 'scan-o', 'fmt', 'scan-v', 'scan-v2', 'scan-c']);
    expect(plugins.find((p) => p.name === 'scan-o')).toMatchObject({ tier: 'official', healthScore: 92, ratingBayes: 4.46, lifecycle: 'active' });
    expect(plugins.find((p) => p.name === 'scan-v')).toMatchObject({ tier: 'verified', healthScore: null, lifecycle: 'paused' });
    expect(plugins.find((p) => p.name === 'scan-v2')).toMatchObject({ lifecycle: 'unmaintained' });
    expect(plugins.find((p) => p.name === 'fmt')).toMatchObject({ tier: 'official' });
    expect(plugins[0]).not.toHaveProperty('orgId');

    mockGenerateText.mockResolvedValue({ output: { project: 'p', organization: 'o', synth: { source: { type: 'github', options: { repo: 'a/b' } }, plugin: { name: 'cdk-synth' } } } });
    await generatePipelineConfig({ prompt: 'scan', plugins, orgId: 'org-1', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' });
    const system = mockGenerateText.mock.calls.at(-1)![0].system as string;
    expect(system).toContain('trust: official, health: 92/100, rating: 4.46/5');
    expect(system).toContain('trust: verified, PAUSED (no new installs)');
    expect(system).toContain('UNMAINTAINED');
    expect(system).toMatch(/prefer trust "own", then "official", then "verified", then the higher health score/);
  });
});

describe('ai-generation-service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // getProviderModels

  describe('getProviderModels', () => {
    it('returns models for a valid provider', () => {
      const models = getProviderModels('anthropic');
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('id');
    });

    it('returns empty array for unknown provider', () => {
      expect(getProviderModels('nonexistent')).toEqual([]);
    });
  });

  // getAvailableProviders

  describe('getAvailableProviders', () => {
    it('returns providers with configured env vars', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const providers = getAvailableProviders();
      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers.find((p) => p.id === 'anthropic')).toBeDefined();
    });
  });

  // generatePipelineConfig

  describe('generatePipelineConfig', () => {
    const baseRequest: GenerationRequest = {
      prompt: 'Build a Node.js app from my GitHub repo acme/my-app',
      plugins: [
        {
          name: 'nodejs-build',
          description: 'Node.js build plugin',
          version: '1.0.0',
          pluginType: 'CodeBuildStep',
          computeType: 'MEDIUM',
          commands: ['npm run build'],
          installCommands: ['npm ci'],
          keywords: ['nodejs', 'javascript', 'typescript', 'build'],
          category: 'language',
          metadata: {},
          env: { NODE_VERSION: '24' },
        },
      ],
      orgId: 'test-org',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'test-custom-key',
    };

    const mockAIOutput = {
      project: 'my-app',
      organization: 'acme',
      description: 'Node.js pipeline for acme/my-app',
      keywords: ['nodejs', 'github'],
      synth: {
        source: { type: 'github', options: { repo: 'acme/my-app' } },
        plugin: { name: 'nodejs-build' },
      },
    };

    it('generates pipeline config from AI output', async () => {
      mockGenerateText.mockResolvedValue({ output: mockAIOutput });

      const result = await generatePipelineConfig(baseRequest);

      expect(result.props).toHaveProperty('project', 'my-app');
      expect(result.props).toHaveProperty('organization', 'acme');
      expect(result.description).toBe('Node.js pipeline for acme/my-app');
      expect(result.keywords).toEqual(['nodejs', 'github']);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('passes system prompt with plugins and user prompt to generateText', async () => {
      mockGenerateText.mockResolvedValue({ output: mockAIOutput });

      await generatePipelineConfig(baseRequest);

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.system).toContain('pipeline configuration assistant');
      expect(call.system).toContain('nodejs-build');
      expect(call.prompt).toBe('Build a Node.js app from my GitHub repo acme/my-app');
    });

    it('lists a qualified listing with its publisher and validates references by (publisher, name)', async () => {
      mockGenerateText.mockResolvedValue({
        output: {
          ...mockAIOutput,
          stages: [{
            stageName: 'Scan',
            steps: [
              { plugin: { publisher: 'acme', name: 'lint' } },
              { plugin: { name: 'lint' } },
              { plugin: { publisher: 'other', name: 'nodejs-build' } },
            ],
          }],
        },
      });
      const result = await generatePipelineConfig({
        ...baseRequest,
        plugins: [...baseRequest.plugins, { ...baseRequest.plugins[0]!, name: 'lint', publisher: 'acme' }],
      });
      expect(mockGenerateText.mock.calls[0][0].system).toContain('- "lint" [publisher: "acme"] (v1.0.0');
      expect(result.validationWarnings).toEqual([
        'Stage plugin "lint" not found in available plugins',
        'Stage plugin "other/nodejs-build" not found in available plugins',
      ]);
    });

    it('throws when AI returns null output', async () => {
      mockGenerateText.mockResolvedValue({ output: null });

      await expect(generatePipelineConfig(baseRequest)).rejects.toThrow(
        'AI did not produce a pipeline configuration',
      );
    });

    it('handles missing optional fields (description, keywords)', async () => {
      mockGenerateText.mockResolvedValue({
        output: {
          project: 'my-app',
          organization: 'acme',
          synth: {
            source: { type: 'github', options: { repo: 'acme/my-app' } },
            plugin: { name: 'nodejs-build' },
          },
        },
      });

      const result = await generatePipelineConfig(baseRequest);
      expect(result.description).toBeUndefined();
      expect(result.keywords).toBeUndefined();
    });

    it('separates description and keywords from props', async () => {
      mockGenerateText.mockResolvedValue({ output: mockAIOutput });

      const result = await generatePipelineConfig(baseRequest);
      expect(result.props).not.toHaveProperty('description');
      expect(result.props).not.toHaveProperty('keywords');
    });

    it('throws for unknown provider with custom key', async () => {
      await expect(
        generatePipelineConfig({ ...baseRequest, provider: 'unknown', apiKey: 'key' }),
      ).rejects.toThrow('Unknown AI provider "unknown"');
    });

    it('throws for invalid model with custom key', async () => {
      await expect(
        generatePipelineConfig({ ...baseRequest, model: 'nonexistent-model', apiKey: 'key' }),
      ).rejects.toThrow('not available for provider');
    });

    it('includes empty plugins message when no plugins are available', async () => {
      mockGenerateText.mockResolvedValue({ output: mockAIOutput });

      await generatePipelineConfig({ ...baseRequest, plugins: [] });

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.system).toContain('No plugins available');
    });
  });

  // streamPipelineConfig — the /generate/stream + /generate/from-url/stream path.
  // It must apply the SAME post-generation enforcement as generatePipelineConfig
  // (force synth.plugin = cdk-synth, inject filter.isDefault) to the resolved
  // output before the route's `done` event / autoCreateMissingPlugins.

  describe('streamPipelineConfig', () => {
    const baseRequest: GenerationRequest = {
      prompt: 'Build a Node.js app from my GitHub repo acme/my-app',
      plugins: [
        {
          name: 'nodejs-build',
          description: 'Node.js build plugin',
          version: '1.0.0',
          pluginType: 'CodeBuildStep',
          computeType: 'MEDIUM',
          commands: ['npm run build'],
          installCommands: ['npm ci'],
          keywords: ['nodejs'],
          category: 'language',
          metadata: {},
          env: {},
        },
      ],
      orgId: 'test-org',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'test-custom-key',
    };

    /** Build a streamText result whose output resolves to the given raw object. */
    function streamResultFor(rawOutput: Record<string, unknown> | undefined) {
      async function* partials() { /* no partials needed for this assertion */ }
      return { partialOutputStream: partials(), output: Promise.resolve(rawOutput) };
    }

    it('enforces cdk-synth + filter.isDefault on the resolved streaming output', async () => {
      // The AI streamed a NON-cdk-synth synth plugin and a stage step with no filter.
      const rawOutput = {
        project: 'my-app',
        organization: 'acme',
        synth: {
          source: { type: 'github', options: { repo: 'acme/my-app' } },
          plugin: { name: 'not-cdk-synth' },
        },
        stages: [
          { stageName: 'Deploy', steps: [{ plugin: { name: 'nodejs-build' } }] },
        ],
      };
      mockStreamText.mockReturnValue(streamResultFor(rawOutput));

      const result = streamPipelineConfig(baseRequest);
      const resolved: any = await result.output;

      // Synth plugin forced to cdk-synth with isDefault injected.
      expect(resolved.synth.plugin.name).toBe('cdk-synth');
      expect(resolved.synth.plugin.filter.isDefault).toBe(true);
      // Stage step gets filter.isDefault injected too.
      expect(resolved.stages[0].steps[0].plugin.filter.isDefault).toBe(true);
    });

    it('leaves an undefined streaming output untouched (no throw)', async () => {
      mockStreamText.mockReturnValue(streamResultFor(undefined));
      const result = streamPipelineConfig(baseRequest);
      await expect(result.output).resolves.toBeUndefined();
    });
  });
});
