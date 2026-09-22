// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AnyFn } from '@pipeline-builder/api-core/testing';
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

const mockCompatModel = { provider: 'openai-compatible', modelId: '' };
const mockCompatFactory = jest.fn((id: string) => ({ ...mockCompatModel, modelId: id }));

const createAnthropic = jest.fn((_opts?: unknown) => mockAnthropicFactory);
const createOpenAI = jest.fn((_opts?: unknown) => mockOpenAIFactory);
const createGoogleGenerativeAI = jest.fn((_opts?: unknown) => mockGoogleFactory);
const createXai = jest.fn((_opts?: unknown) => mockXaiFactory);
const createAmazonBedrock = jest.fn((_opts?: unknown) => mockBedrockFactory);
const createOpenAICompatible = jest.fn((_opts?: unknown) => mockCompatFactory);

jest.unstable_mockModule('@ai-sdk/anthropic', () => ({ createAnthropic }));
jest.unstable_mockModule('@ai-sdk/openai', () => ({ createOpenAI }));
jest.unstable_mockModule('@ai-sdk/google', () => ({ createGoogleGenerativeAI }));
jest.unstable_mockModule('@ai-sdk/xai', () => ({ createXai }));
jest.unstable_mockModule('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock }));
jest.unstable_mockModule('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

// Bedrock is keyless — it authenticates through the AWS credential chain.
const credentialChain = jest.fn<AnyFn>();
const fromNodeProviderChain = jest.fn((_opts?: unknown) => credentialChain);
jest.unstable_mockModule('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain }));

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
    // ...and the credential-source markers, so a developer's own AWS_PROFILE
    // (or a CI role) can't make Bedrock appear in the "nothing configured" cases.
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
    delete process.env.AWS_PROFILE;
    delete process.env.BEDROCK_ENABLED;
    // The OpenAI-compatible (local) provider registers when a base URL is present —
    // clear it so the fixed-provider counts are deterministic; its own tests set it.
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    delete process.env.OPENAI_COMPATIBLE_MODELS;
    delete process.env.OPENAI_COMPATIBLE_MODEL;
    delete process.env.OPENAI_COMPATIBLE_NAME;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
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
      // Bedrock is keyless: static keys are a credential SOURCE, but it still
      // needs a region to call, so both are required for it to register.
      process.env.AWS_REGION = 'us-east-1';

      const { getAvailableProviders } = await freshImport();
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(5);
    });

    /** Clear every provider key + AWS credential-source marker. */
    const clearProviderEnv = () => {
      for (const k of [
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'XAI_API_KEY',
        'AWS_ACCESS_KEY_ID', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
        'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE',
        'AWS_PROFILE', 'BEDROCK_ENABLED',
      ]) delete process.env[k];
    };

    it('REGRESSION: does NOT register Bedrock when only a REGION is set', async () => {
      // Every deploy target sets AWS_REGION (pipeline synthesis needs it),
      // including minikube and docker-compose where nothing grants the pod AWS
      // credentials. Advertising Bedrock off the region alone made it the ONLY
      // provider on a local install, so `resolveAskModel` defaulted to it and
      // every Ask turn failed with "Could not load credentials from any
      // providers" — an AWS error in response to a docs question.
      clearProviderEnv();
      process.env.AWS_REGION = 'us-east-1';

      const { getAvailableProviders } = await freshImport();

      expect(getAvailableProviders().map((p) => p.id)).not.toContain('amazon-bedrock');
    });

    it.each([
      ['static keys', 'AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE'],
      ['EKS Pod Identity', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'http://169.254.170.23/v1/credentials'],
      ['ECS task role', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/abc'],
      ['IRSA', 'AWS_WEB_IDENTITY_TOKEN_FILE', '/var/run/secrets/token'],
      ['a shared-config profile', 'AWS_PROFILE', 'dev'],
      ['the EC2 instance-profile opt-in', 'BEDROCK_ENABLED', 'true'],
    ])('registers Bedrock (keyless / IAM role) with %s, and no API key', async (_label, envVar, value) => {
      clearProviderEnv();
      process.env.AWS_REGION = 'us-east-1';
      process.env[envVar] = value;

      const { getAvailableProviders } = await freshImport();

      expect(getAvailableProviders().map((p) => p.id)).toEqual(['amazon-bedrock']);
    });

    it('does NOT register Bedrock when credentials exist but no region does', async () => {
      // The chain could resolve, but there is no region to call.
      clearProviderEnv();
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/var/run/secrets/token';

      const { getAvailableProviders } = await freshImport();

      expect(getAvailableProviders().map((p) => p.id)).not.toContain('amazon-bedrock');
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

      expect(getProviderModels('anthropic').map((m) => m.id)).toContain('claude-sonnet-5');
      expect(getProviderModels('openai').map((m) => m.id)).toContain('gpt-5.6-sol');
      expect(getProviderModels('google').map((m) => m.id)).toContain('gemini-3.7-flash');
      expect(getProviderModels('xai').map((m) => m.id)).toContain('grok-4.6');
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
      resolveModel('anthropic', 'claude-sonnet-5');
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

      expect(() => resolveModel('anthropic', 'claude-sonnet-5')).toThrow(
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
      const model = resolveModel('anthropic', 'claude-sonnet-5');

      expect(model).toBeDefined();
      expect(mockAnthropicFactory).toHaveBeenCalledWith('claude-sonnet-5');
    });

    it('should resolve models for each configured provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'key-1';
      process.env.OPENAI_API_KEY = 'key-2';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'key-3';
      process.env.XAI_API_KEY = 'key-4';
      process.env.AWS_ACCESS_KEY_ID = 'key-5';
      // Bedrock is keyless: static keys are a credential SOURCE, but it still
      // needs a region to call, so both are required for it to register.
      process.env.AWS_REGION = 'us-east-1';

      const { resolveModel } = await freshImport();

      expect(resolveModel('anthropic', 'claude-sonnet-5')).toBeDefined();
      expect(resolveModel('openai', 'gpt-5.6-sol')).toBeDefined();
      expect(resolveModel('google', 'gemini-3.7-flash')).toBeDefined();
      expect(resolveModel('xai', 'grok-4.6')).toBeDefined();
      expect(resolveModel('amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBeDefined();
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

      const model = createModelWithKey('anthropic', 'claude-sonnet-5', 'custom-key');

      expect(model).toBeDefined();
      expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for OpenAI', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('openai', 'gpt-5.6-sol', 'custom-key');

      expect(model).toBeDefined();
      expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for Google', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('google', 'gemini-3.7-flash', 'custom-key');

      expect(model).toBeDefined();
      expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model with a custom key for xAI', async () => {
      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('xai', 'grok-4.6', 'custom-key');

      expect(model).toBeDefined();
      expect(createXai).toHaveBeenCalledWith({ apiKey: 'custom-key' });
    });

    it('should create a model for Amazon Bedrock when an AWS region is configured (custom key ignored)', async () => {
      // Bedrock authenticates via the IAM role: it needs a region AND a
      // resolvable credential source (here, an IRSA token file).
      process.env.AWS_REGION = 'us-east-1';
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/var/run/secrets/token';

      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'key');

      expect(model).toBeDefined();
      // The supplied key is dropped — Bedrock authenticates through the AWS
      // credential chain (IAM role), never a per-request key.
      expect(createAmazonBedrock).toHaveBeenCalledWith({ credentialProvider: credentialChain });
    });

    it('throws at config time for Bedrock when no AWS region is configured (no silent key drop)', async () => {
      // beforeEach clears AWS_REGION/AWS_DEFAULT_REGION — keyless auth is unavailable.
      const { createModelWithKey } = await freshImport();

      expect(() =>
        createModelWithKey('amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'key'),
      ).toThrow('authenticates via the AWS IAM role');
      expect(createAmazonBedrock).not.toHaveBeenCalled();
    });

    it('accepts AWS_DEFAULT_REGION as the Bedrock availability signal', async () => {
      process.env.AWS_DEFAULT_REGION = 'eu-west-1';
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/var/run/secrets/token';

      const { createModelWithKey } = await freshImport();

      const model = createModelWithKey('amazon-bedrock', 'us.amazon.nova-pro-v1:0', 'key');
      expect(model).toBeDefined();
      expect(createAmazonBedrock).toHaveBeenCalledWith({ credentialProvider: credentialChain });
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
      const model = createModelWithKey('anthropic', 'claude-sonnet-5', 'custom-key');
      expect(model).toBeDefined();

      // But registry is still empty
      const providers = getAvailableProviders();
      expect(providers).toEqual([]);
    });
  });

  // OpenAI-compatible (local / self-hosted Docker model) provider
  describe('openai-compatible (local) provider', () => {
    it('does NOT register when no base URL is configured', async () => {
      const { getAvailableProviders } = await freshImport();
      expect(getAvailableProviders().map((p) => p.id)).not.toContain('openai-compatible');
    });

    it('registers from OPENAI_COMPATIBLE_BASE_URL with models parsed from env', async () => {
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://ask-model:12434/v1';
      process.env.OPENAI_COMPATIBLE_MODELS = 'qwen2.5-coder|Qwen 2.5 Coder, llama3.3';

      const { getAvailableProviders } = await freshImport();
      const compat = getAvailableProviders().find((p) => p.id === 'openai-compatible');

      expect(compat).toBeDefined();
      expect(compat!.models).toEqual([
        { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
        { id: 'llama3.3', name: 'llama3.3' },
      ]);
    });

    it('falls back to a generic "local" model when no model list is set', async () => {
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://ask-model:12434/v1';

      const { getAvailableProviders } = await freshImport();
      const compat = getAvailableProviders().find((p) => p.id === 'openai-compatible');

      expect(compat!.models).toEqual([{ id: 'local', name: 'Local model' }]);
    });

    it('resolveModel builds the model via createOpenAICompatible with the configured base URL', async () => {
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://ask-model:12434/v1';
      process.env.OPENAI_COMPATIBLE_MODELS = 'qwen2.5-coder';

      const { resolveModel } = await freshImport();
      const model = resolveModel('openai-compatible', 'qwen2.5-coder') as unknown as { modelId: string };

      expect(createOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://ask-model:12434/v1', name: 'openai-compatible' }),
      );
      expect(model.modelId).toBe('qwen2.5-coder');
    });

    it('resolveModel rejects a model id not served by the local endpoint', async () => {
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://ask-model:12434/v1';
      process.env.OPENAI_COMPATIBLE_MODELS = 'qwen2.5-coder';

      const { resolveModel } = await freshImport();
      expect(() => resolveModel('openai-compatible', 'not-served')).toThrow(/not available/);
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

describe('Bedrock credentials', () => {
  const ENV = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    // A region AND a credential source — Bedrock needs both to be advertised.
    process.env = { ...ENV, AWS_REGION: 'us-east-1', AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token' };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });
  afterAll(() => { process.env = ENV; });

  it('hands Bedrock the AWS credential chain, so an IAM role works without static keys', async () => {
    // Regression: bare `createAmazonBedrock()` reads only AWS_ACCESS_KEY_ID /
    // AWS_SECRET_ACCESS_KEY, so on EKS Pod Identity (no env keys) every call
    // failed with "AWS SigV4 authentication requires AWS credentials".
    const { resolveModel } = await freshImport();
    resolveModel('amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');

    expect(fromNodeProviderChain).toHaveBeenCalled();
    expect(createAmazonBedrock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProvider: credentialChain }),
    );
  });
});
