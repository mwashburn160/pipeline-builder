/**
 * Unit tests for the AI plugin generation service.
 *
 * @module test/ai-plugin-generation-service
 */

// ---------------------------------------------------------------------------
// Mock external dependencies — must be set up before importing the service
// ---------------------------------------------------------------------------

const mockGenerateText = jest.fn();

jest.mock('ai', () => ({
  generateText: mockGenerateText,
  Output: {
    object: jest.fn((opts: any) => ({ type: 'object', schema: opts.schema })),
  },
}));

jest.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'amazon-bedrock', modelId }))),
}));
jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'anthropic', modelId }))),
}));
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'openai', modelId }))),
}));
jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'google', modelId }))),
}));
jest.mock('@ai-sdk/xai', () => ({
  createXai: jest.fn(() => jest.fn((modelId: string) => ({ provider: 'xai', modelId }))),
}));

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
  AI_PROVIDER_CATALOG: {
    'anthropic': {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      ],
    },
    'openai': {
      id: 'openai',
      name: 'OpenAI',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o' },
      ],
    },
    'google': {
      id: 'google',
      name: 'Google',
      models: [
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      ],
    },
    'xai': {
      id: 'xai',
      name: 'xAI (Grok)',
      models: [
        { id: 'grok-3', name: 'Grok 3' },
      ],
    },
    'amazon-bedrock': {
      id: 'amazon-bedrock',
      name: 'Amazon Bedrock',
      models: [
        { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2' },
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
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      ],
      'openai': [{ id: 'gpt-4o', name: 'GPT-4o' }],
      'google': [{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }],
      'xai': [{ id: 'grok-3', name: 'Grok 3' }],
      'amazon-bedrock': [{ id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2' }],
    };
    return catalog[id] ?? [];
  }),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import {
  getAvailableProviders,
  getProviderModels,
  generatePluginConfig,
  type PluginGenerationRequest,
} from '../src/services/ai-plugin-generation-service';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ai-plugin-generation-service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the registry by clearing the module cache — the registry is a Map
    // initialized lazily, so we need fresh env for each test
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // getProviderModels
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // getAvailableProviders
  // -------------------------------------------------------------------------

  describe('getAvailableProviders', () => {
    it('returns providers with configured env vars', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      // Registry is lazily initialized; first call triggers init
      const providers = getAvailableProviders();
      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers.find((p) => p.id === 'anthropic')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // generatePluginConfig
  // -------------------------------------------------------------------------

  describe('generatePluginConfig', () => {
    const baseRequest: PluginGenerationRequest = {
      prompt: 'Create a Node.js build plugin',
      orgId: 'test-org',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-custom-key',
    };

    const mockAIOutput = {
      name: 'nodejs-build',
      description: 'Node.js build plugin',
      version: '1.0.0',
      pluginType: 'CodeBuildStep',
      computeType: 'MEDIUM',
      keywords: ['nodejs', 'build'],
      installCommands: ['npm ci'],
      commands: ['npm run build'],
      dockerfile: 'FROM node:20-slim\nWORKDIR /app',
    };

    it('generates a plugin config from AI output', async () => {
      mockGenerateText.mockResolvedValue({ output: mockAIOutput });

      const result = await generatePluginConfig(baseRequest);

      expect(result.config.name).toBe('nodejs-build');
      expect(result.config.version).toBe('1.0.0');
      expect(result.config.commands).toEqual(['npm run build']);
      expect(result.dockerfile).toBe('FROM node:20-slim\nWORKDIR /app');
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('passes system prompt and user prompt to generateText', async () => {
      mockGenerateText.mockResolvedValue({ output: mockAIOutput });

      await generatePluginConfig(baseRequest);

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.system).toContain('plugin configuration assistant');
      expect(call.prompt).toBe('Create a Node.js build plugin');
    });

    it('throws when AI returns null output', async () => {
      mockGenerateText.mockResolvedValue({ output: null });

      await expect(generatePluginConfig(baseRequest)).rejects.toThrow(
        'AI did not produce a plugin configuration',
      );
    });

    it('handles optional fields (description, primaryOutputDirectory, env)', async () => {
      mockGenerateText.mockResolvedValue({
        output: {
          ...mockAIOutput,
          description: null,
          primaryOutputDirectory: null,
          env: null,
        },
      });

      const result = await generatePluginConfig(baseRequest);
      expect(result.config.description).toBeUndefined();
      expect(result.config.primaryOutputDirectory).toBeUndefined();
      expect(result.config.env).toBeUndefined();
    });

    it('uses custom API key when provided', async () => {
      mockGenerateText.mockResolvedValue({ output: mockAIOutput });

      await generatePluginConfig(baseRequest);

      // Should have called generateText (the custom key path uses createModelWithKey)
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('throws for unknown provider with custom key', async () => {
      await expect(
        generatePluginConfig({ ...baseRequest, provider: 'unknown', apiKey: 'key' }),
      ).rejects.toThrow('Unknown AI provider "unknown"');
    });

    it('throws for invalid model with custom key', async () => {
      await expect(
        generatePluginConfig({ ...baseRequest, model: 'nonexistent-model', apiKey: 'key' }),
      ).rejects.toThrow('not available for provider');
    });
  });
});
