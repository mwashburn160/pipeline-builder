// Mock external dependencies — must be set up before importing the service

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

jest.mock('@mwashburn160/api-core', () => {
  class ValidationError extends Error {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    constructor(message: string) { super(message); this.name = 'ValidationError'; }
  }
  return {
    ValidationError,
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
  };
});

jest.mock('@mwashburn160/pipeline-core', () => ({
  db: { select: jest.fn().mockReturnThis(), from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([]) },
  schema: { plugin: {} },
}));

// Import AFTER mocks

import {
  getAvailableProviders,
  getProviderModels,
  generatePipelineConfig,
  type GenerationRequest,
} from '../src/services/ai-generation-service';

// Tests

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
      model: 'claude-sonnet-4-20250514',
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
});
