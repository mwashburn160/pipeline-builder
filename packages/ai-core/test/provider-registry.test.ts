// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';

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

const createAnthropic = jest.fn(() => mockAnthropicFactory);
const createOpenAI = jest.fn(() => mockOpenAIFactory);
const createGoogleGenerativeAI = jest.fn(() => mockGoogleFactory);
const createXai = jest.fn(() => mockXaiFactory);
const createAmazonBedrock = jest.fn(() => mockBedrockFactory);

jest.unstable_mockModule('@ai-sdk/anthropic', () => ({ createAnthropic }));
jest.unstable_mockModule('@ai-sdk/openai', () => ({ createOpenAI }));
jest.unstable_mockModule('@ai-sdk/google', () => ({ createGoogleGenerativeAI }));
jest.unstable_mockModule('@ai-sdk/xai', () => ({ createXai }));
jest.unstable_mockModule('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock }));

// Helpers

/**
 * The registry is lazily initialized once — between test groups we need to
 * re-import the module so the registry starts fresh. This helper clears the
 * module cache and returns a fresh import.
 */
async function freshImport() {
  // Clear cached module so the registry Map resets
  jest.resetModules();
  return import('../src/provider-registry.js');
}

// Tests

describe('ai-core provider-registry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Shallow clone env so tests can safely mutate it
    process.env = { ...originalEnv };
    // Bedrock (keyless) registers when an AWS region is present — clear it so the
    // "no key" cases are deterministic; the Bedrock-specific tests set it.
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // getAvailableProviders
  describe('getAvailableProviders', () => {
    it('should return an empty array when no API keys are set', async () => {
      // Ensure all provider env vars are unset
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = await freshImport();
      const providers = getAvailableProviders();

      expect(providers).toEqual([]);
    });

    it('should return only providers with API keys configured', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = await freshImport();
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('anthropic');
      expect(providers[0].name).toBe('Anthropic');
    });

    it('should return multiple providers when multiple keys are set', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key-1';
      process.env.OPENAI_API_KEY = 'test-key-2';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key-3';
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = await freshImport();
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(3);
      const ids = providers.map((p) => p.id);
      expect(ids).toContain('anthropic');
      expect(ids).toContain('openai');
      expect(ids).toContain('google');
    });

    it('should return all five providers when all keys are set', async () => {
      process.env.ANTHROPIC_API_KEY = 'key-1';
      process.env.OPENAI_API_KEY = 'key-2';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'key-3';
      process.env.XAI_API_KEY = 'key-4';
      process.env.AWS_ACCESS_KEY_ID = 'key-5';

      const { getAvailableProviders } = await freshImport();
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(5);
    });

    it('registers Bedrock (keyless / IAM role) when an AWS region is set, with no access key', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;
      process.env.AWS_REGION = 'us-east-1';

      const { getAvailableProviders } = await freshImport();
      const providers = getAvailableProviders();

      expect(providers.map((p) => p.id)).toEqual(['amazon-bedrock']);
    });

    it('should include models in each provider entry', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = await freshImport();
      const providers = getAvailableProviders();

      expect(providers[0].models).toBeDefined();
      expect(providers[0].models.length).toBeGreaterThan(0);
      expect(providers[0].models[0]).toHaveProperty('id');
      expect(providers[0].models[0]).toHaveProperty('name');
    });
  });

  // getProviderModels
  describe('getProviderModels', () => {
    it('should return models for a known provider', async () => {
      const { getProviderModels } = await freshImport();
      const models = getProviderModels('anthropic');

      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('id');
      expect(models[0]).toHaveProperty('name');
    });

    it('should return an empty array for an unknown provider', async () => {
      const { getProviderModels } = await freshImport();
      const models = getProviderModels('unknown-provider');

      expect(models).toEqual([]);
    });

    it('should return models without requiring env vars (static catalog lookup)', async () => {
      // No env vars set — getProviderModels reads from the static catalog
      delete process.env.ANTHROPIC_API_KEY;

      const { getProviderModels } = await freshImport();
      const models = getProviderModels('anthropic');

      expect(models.length).toBeGreaterThan(0);
    });

    it('should return correct models for each provider', async () => {
      const { getProviderModels } = await freshImport();

      expect(getProviderModels('anthropic').map((m) => m.id)).toContain('claude-sonnet-4-20250514');
      expect(getProviderModels('openai').map((m) => m.id)).toContain('gpt-4o');
      expect(getProviderModels('google').map((m) => m.id)).toContain('gemini-2.0-flash');
      expect(getProviderModels('xai').map((m) => m.id)).toContain('grok-3');
      expect(getProviderModels('amazon-bedrock').length).toBeGreaterThan(0);
    });
  });

  // Lazy initialization
  describe('lazy initialization', () => {
    it('should only initialize the registry once (idempotent)', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { getAvailableProviders } = await freshImport();

      // First call initializes registry
      getAvailableProviders();
      const firstCallCount = createAnthropic.mock.calls.length;

      // Second call should NOT re-initialize
      getAvailableProviders();
      expect(createAnthropic.mock.calls.length).toBe(firstCallCount);
    });

    it('should initialize on first resolveModel call if not already done', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = await freshImport();

      // resolveModel should trigger init
      resolveModel('anthropic', 'claude-sonnet-4-20250514');
      expect(createAnthropic).toHaveBeenCalled();
    });
  });

  // resolveModel
  describe('resolveModel', () => {
    it('should throw when provider is not configured', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = await freshImport();

      expect(() => resolveModel('anthropic', 'claude-sonnet-4-20250514')).toThrow(
        'AI provider "anthropic" is not configured',
      );
    });

    it('should throw when model is not valid for the provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = await freshImport();

      expect(() => resolveModel('anthropic', 'nonexistent-model')).toThrow(
        'Model "nonexistent-model" is not available for provider "anthropic"',
      );
    });

    it('should include available models in the error message', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = await freshImport();

      expect(() => resolveModel('anthropic', 'bad-model')).toThrow('Available models:');
    });

    it('should return a LanguageModel for a valid provider + model', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { resolveModel } = await freshImport();
      const model = resolveModel('anthropic', 'claude-sonnet-4-20250514');

      expect(model).toBeDefined();
      expect(mockAnthropicFactory).toHaveBeenCalledWith('claude-sonnet-4-20250514');
    });

    it('should resolve models for each configured provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'key-1';
      process.env.OPENAI_API_KEY = 'key-2';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'key-3';
      process.env.XAI_API_KEY = 'key-4';
      process.env.AWS_ACCESS_KEY_ID = 'key-5';

      const { resolveModel } = await freshImport();

      expect(resolveModel('anthropic', 'claude-sonnet-4-20250514')).toBeDefined();
      expect(resolveModel('openai', 'gpt-4o')).toBeDefined();
      expect(resolveModel('google', 'gemini-2.0-flash')).toBeDefined();
      expect(resolveModel('xai', 'grok-3')).toBeDefined();
      expect(resolveModel('amazon-bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0')).toBeDefined();
    });
  });

  // createModelWithKey
  describe('createModelWithKey', () => {
    it('should throw for an unknown provider', async () => {
      const { createModelWithKey } = await freshImport();

      expect(() => createModelWithKey('fake-provider', 'model-1', 'key')).toThrow(
        'Unknown AI provider "fake-provider"',
      );
    });

    it('should include supported providers in the error message', async () => {
      const { createModelWithKey } = await freshImport();

      expect(() => createModelWithKey('fake-provider', 'model-1', 'key')).toThrow('Supported:');
    });

    it('should throw for an invalid model on a valid provider', async () => {
      const { createModelWithKey } = await freshImport();

      expect(() => createModelWithKey('anthropic', 'nonexistent-model', 'key')).toThrow(
        'Model "nonexistent-model" is not available for provider "anthropic"',
      );
    });

    it('should create a model with a custom key for Anthropic', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('anthropic', 'claude-sonnet-4-20250514', 'custom-key');

      expect(model).toBeDefined();
      expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for OpenAI', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('openai', 'gpt-4o', 'custom-key');

      expect(model).toBeDefined();
      expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for Google', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('google', 'gemini-2.0-flash', 'custom-key');

      expect(model).toBeDefined();
      expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for xAI', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('xai', 'grok-3', 'custom-key');

      expect(model).toBeDefined();
      expect(createXai).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model for Amazon Bedrock (no custom key needed)', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('amazon-bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0', 'key');

      expect(model).toBeDefined();
      expect(createAmazonBedrock).toHaveBeenCalled();
    });

    it('should not affect the registry (uses ephemeral provider instances)', async () => {
      // No env vars — registry is empty
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;

      const { createModelWithKey, getAvailableProviders } = await freshImport();

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
    it('should export all expected functions', async () => {
      const mod = await freshImport();

      expect(typeof mod.getAvailableProviders).toBe('function');
      expect(typeof mod.getProviderModels).toBe('function');
      expect(typeof mod.resolveModel).toBe('function');
      expect(typeof mod.createModelWithKey).toBe('function');
    });
  });
});
