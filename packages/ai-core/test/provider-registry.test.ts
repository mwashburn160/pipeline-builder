// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-require-imports */

// Mock all AI SDK providers BEFORE importing the module under test

const mockAnthropicModel = { provider: 'anthropic', modelId: '' };
const mockOpenAIModel = { provider: 'openai', modelId: '' };
const mockGoogleModel = { provider: 'google', modelId: '' };
const mockXaiModel = { provider: 'xai', modelId: '' };
const mockBedrockModel = { provider: 'amazon-bedrock', modelId: '' };

const mockAnthropicFactory = jest.fn((id: string) => ({ ...mockAnthropicModel, modelId: id }));
const mockOpenAIFactory = jest.fn((id: string) => ({ ...mockOpenAIModel, modelId: id }));
const mockGoogleFactory = jest.fn((id: string) => ({ ...mockGoogleModel, modelId: id }));
const mockXaiFactory = jest.fn((id: string) => ({ ...mockXaiModel, modelId: id }));
const mockBedrockFactory = jest.fn((id: string) => ({ ...mockBedrockModel, modelId: id }));

jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: jest.fn(() => mockAnthropicFactory),
}));
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => mockOpenAIFactory),
}));
jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => mockGoogleFactory),
}));
jest.mock('@ai-sdk/xai', () => ({
  createXai: jest.fn(() => mockXaiFactory),
}));
jest.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: jest.fn(() => mockBedrockFactory),
}));

// Helpers

/**
 * The registry is lazily initialized once — between test groups we need to
 * re-import the module so the registry starts fresh. This helper clears the
 * module cache and returns a fresh import.
 */
function freshImport() {
  // Clear cached module so the registry Map resets
  jest.resetModules();
  return require('../src/provider-registry') as typeof import('../src/provider-registry');
}

// Tests

describe('ai-core provider-registry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Shallow clone env so tests can safely mutate it
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // getAvailableProviders
  describe('getAvailableProviders', () => {
    it('should return an empty array when no API keys are set', () => {
      // Ensure all provider env vars are unset
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = freshImport();
      const providers = getAvailableProviders();

      expect(providers).toEqual([]);
    });

    it('should return only providers with API keys configured', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = freshImport();
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('anthropic');
      expect(providers[0].name).toBe('Anthropic');
    });

    it('should return multiple providers when multiple keys are set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key-1';
      process.env.OPENAI_API_KEY = 'test-key-2';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-3';
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = freshImport();
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(3);
      const ids = providers.map((p) => p.id);
      expect(ids).toContain('anthropic');
      expect(ids).toContain('openai');
      expect(ids).toContain('google');
    });

    it('should return all five providers when all keys are set', () => {
      process.env.ANTHROPIC_API_KEY = 'key-1';
      process.env.OPENAI_API_KEY = 'key-2';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'key-3';
      process.env.XAI_API_KEY = 'key-4';
      process.env.AWS_ACCESS_KEY_ID = 'key-5';

      const { getAvailableProviders } = freshImport();
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(5);
    });

    it('should include models in each provider entry', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = freshImport();
      const providers = getAvailableProviders();

      expect(providers[0].models).toBeDefined();
      expect(providers[0].models.length).toBeGreaterThan(0);
      expect(providers[0].models[0]).toHaveProperty('id');
      expect(providers[0].models[0]).toHaveProperty('name');
    });
  });

  // getProviderModels
  describe('getProviderModels', () => {
    it('should return models for a known provider', () => {
      const { getProviderModels } = freshImport();
      const models = getProviderModels('anthropic');

      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('id');
      expect(models[0]).toHaveProperty('name');
    });

    it('should return an empty array for an unknown provider', () => {
      const { getProviderModels } = freshImport();
      const models = getProviderModels('unknown-provider');

      expect(models).toEqual([]);
    });

    it('should return models without requiring env vars (static catalog lookup)', () => {
      // No env vars set — getProviderModels reads from the static catalog
      delete process.env.ANTHROPIC_API_KEY;

      const { getProviderModels } = freshImport();
      const models = getProviderModels('anthropic');

      expect(models.length).toBeGreaterThan(0);
    });

    it('should return correct models for each provider', () => {
      const { getProviderModels } = freshImport();

      expect(getProviderModels('anthropic').map((m) => m.id)).toContain('claude-sonnet-4-20250514');
      expect(getProviderModels('openai').map((m) => m.id)).toContain('gpt-4o');
      expect(getProviderModels('google').map((m) => m.id)).toContain('gemini-2.0-flash');
      expect(getProviderModels('xai').map((m) => m.id)).toContain('grok-3');
      expect(getProviderModels('amazon-bedrock').length).toBeGreaterThan(0);
    });
  });

  // Lazy initialization
  describe('lazy initialization', () => {
    it('should only initialize the registry once (idempotent)', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = freshImport();
      const { createAnthropic } = require('@ai-sdk/anthropic');

      // First call initializes registry
      getAvailableProviders();
      const firstCallCount = createAnthropic.mock.calls.length;

      // Second call should NOT re-initialize
      getAvailableProviders();
      expect(createAnthropic.mock.calls.length).toBe(firstCallCount);
    });

    it('should initialize on first resolveModel call if not already done', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = freshImport();
      const { createAnthropic } = require('@ai-sdk/anthropic');

      // resolveModel should trigger init
      resolveModel('anthropic', 'claude-sonnet-4-20250514');
      expect(createAnthropic).toHaveBeenCalled();
    });
  });

  // resolveModel
  describe('resolveModel', () => {
    it('should throw when provider is not configured', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = freshImport();

      expect(() => resolveModel('anthropic', 'claude-sonnet-4-20250514')).toThrow(
        'AI provider "anthropic" is not configured',
      );
    });

    it('should throw when model is not valid for the provider', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = freshImport();

      expect(() => resolveModel('anthropic', 'nonexistent-model')).toThrow(
        'Model "nonexistent-model" is not available for provider "anthropic"',
      );
    });

    it('should include available models in the error message', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = freshImport();

      expect(() => resolveModel('anthropic', 'bad-model')).toThrow('Available models:');
    });

    it('should return a LanguageModel for a valid provider + model', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = freshImport();
      const model = resolveModel('anthropic', 'claude-sonnet-4-20250514');

      expect(model).toBeDefined();
      expect(mockAnthropicFactory).toHaveBeenCalledWith('claude-sonnet-4-20250514');
    });

    it('should resolve models for each configured provider', () => {
      process.env.ANTHROPIC_API_KEY = 'key-1';
      process.env.OPENAI_API_KEY = 'key-2';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'key-3';
      process.env.XAI_API_KEY = 'key-4';
      process.env.AWS_ACCESS_KEY_ID = 'key-5';

      const { resolveModel } = freshImport();

      expect(resolveModel('anthropic', 'claude-sonnet-4-20250514')).toBeDefined();
      expect(resolveModel('openai', 'gpt-4o')).toBeDefined();
      expect(resolveModel('google', 'gemini-2.0-flash')).toBeDefined();
      expect(resolveModel('xai', 'grok-3')).toBeDefined();
      expect(resolveModel('amazon-bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0')).toBeDefined();
    });
  });

  // createModelWithKey
  describe('createModelWithKey', () => {
    it('should throw for an unknown provider', () => {
      const { createModelWithKey } = freshImport();

      expect(() => createModelWithKey('fake-provider', 'model-1', 'key')).toThrow(
        'Unknown AI provider "fake-provider"',
      );
    });

    it('should include supported providers in the error message', () => {
      const { createModelWithKey } = freshImport();

      expect(() => createModelWithKey('fake-provider', 'model-1', 'key')).toThrow('Supported:');
    });

    it('should throw for an invalid model on a valid provider', () => {
      const { createModelWithKey } = freshImport();

      expect(() => createModelWithKey('anthropic', 'nonexistent-model', 'key')).toThrow(
        'Model "nonexistent-model" is not available for provider "anthropic"',
      );
    });

    it('should create a model with a custom key for Anthropic', () => {
      const { createModelWithKey } = freshImport();
      const { createAnthropic } = require('@ai-sdk/anthropic');

      const model = createModelWithKey('anthropic', 'claude-sonnet-4-20250514', 'custom-key');

      expect(model).toBeDefined();
      expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for OpenAI', () => {
      const { createModelWithKey } = freshImport();
      const { createOpenAI } = require('@ai-sdk/openai');

      const model = createModelWithKey('openai', 'gpt-4o', 'custom-key');

      expect(model).toBeDefined();
      expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for Google', () => {
      const { createModelWithKey } = freshImport();
      const { createGoogleGenerativeAI } = require('@ai-sdk/google');

      const model = createModelWithKey('google', 'gemini-2.0-flash', 'custom-key');

      expect(model).toBeDefined();
      expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for xAI', () => {
      const { createModelWithKey } = freshImport();
      const { createXai } = require('@ai-sdk/xai');

      const model = createModelWithKey('xai', 'grok-3', 'custom-key');

      expect(model).toBeDefined();
      expect(createXai).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model for Amazon Bedrock (no custom key needed)', () => {
      const { createModelWithKey } = freshImport();
      const { createAmazonBedrock } = require('@ai-sdk/amazon-bedrock');

      const model = createModelWithKey('amazon-bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0', 'key');

      expect(model).toBeDefined();
      expect(createAmazonBedrock).toHaveBeenCalled();
    });

    it('should not affect the registry (uses ephemeral provider instances)', () => {
      // No env vars — registry is empty
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { createModelWithKey, getAvailableProviders } = freshImport();

      // createModelWithKey works without env vars
      const model = createModelWithKey('anthropic', 'claude-sonnet-4-20250514', 'custom-key');
      expect(model).toBeDefined();

      // But registry is still empty
      const providers = getAvailableProviders();
      expect(providers).toEqual([]);
    });
  });

  // Module exports
  describe('module exports', () => {
    it('should export all expected functions', () => {
      const mod = freshImport();

      expect(typeof mod.getAvailableProviders).toBe('function');
      expect(typeof mod.getProviderModels).toBe('function');
      expect(typeof mod.resolveModel).toBe('function');
      expect(typeof mod.createModelWithKey).toBe('function');
    });
  });
});
