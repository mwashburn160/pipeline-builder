// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * F3b — a BYO (bring-your-own) AI key must NEVER fall back to a platform-configured
 * provider key. The fallback path resolves models from the platform's env keys
 * (`resolveModel`), which would silently spend the platform's AI budget on a
 * request the caller intended to bill to their own key. A BYO primary failure is
 * terminal; a NON-BYO (platform) request still falls back as before.
 *
 * The provider registry is env-driven and memoized on first use, so BOTH keys are
 * set BEFORE importing the service — the fallback provider (openai) is genuinely
 * available, proving the guard suppresses a fallback that WOULD otherwise succeed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Configure both providers BEFORE the ai-core registry initializes.
process.env.ANTHROPIC_API_KEY = 'platform-anthropic-key';
process.env.OPENAI_API_KEY = 'platform-openai-key';

const mockGenerateText = jest.fn<(...args: any[]) => any>();
const mockStreamText = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('ai', () => ({
  generateText: mockGenerateText,
  streamText: mockStreamText,
  Output: { object: jest.fn((opts: any) => ({ type: 'object', schema: opts.schema })) },
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

const AI_CATALOG = {
  anthropic: { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 4' }] },
  openai: { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] },
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  AI_PROVIDER_CATALOG: AI_CATALOG,
  AI_PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' },
  getAIProviderModels: jest.fn((id: string) => (AI_CATALOG as any)[id]?.models ?? []),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const tx = { select: jest.fn().mockReturnThis(), from: jest.fn().mockReturnThis(), where: jest.fn<(...a: any[]) => any>().mockResolvedValue([]) };
  return { db: tx, schema: { plugin: {} }, withTenantTx: (fn: (t: typeof tx) => unknown) => fn(tx) };
});

const { generatePipelineConfig } = await import('../src/services/ai-generation-service.js');
type GenerationRequest = import('../src/services/ai-generation-service.js').GenerationRequest;

const baseRequest: GenerationRequest = {
  prompt: 'build a node app',
  plugins: [],
  orgId: 'test-org',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
};

const OK_OUTPUT = {
  output: {
    project: 'app',
    organization: 'test',
    synth: { source: { type: 'github', options: { repo: 'test/app' } }, plugin: { name: 'cdk-synth' } },
  },
};

describe('F3b — BYO key must not fall back to platform provider keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('BYO key + failed primary + fallback available → throws, never uses the platform fallback', async () => {
    mockGenerateText.mockResolvedValue(OK_OUTPUT);

    await expect(generatePipelineConfig({
      ...baseRequest,
      provider: 'anthropic',
      model: 'nonexistent-model', // invalid → createModelWithKey throws
      apiKey: 'caller-byo-key',
      fallbackProviders: ['openai'], // WOULD resolve via the platform OPENAI_API_KEY
    })).rejects.toThrow(/not available for provider/);

    // The platform fallback was NOT taken — no provider round-trip happened.
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('NON-BYO (platform) request with the same failure DOES fall back to the platform provider', async () => {
    mockGenerateText.mockResolvedValue(OK_OUTPUT);

    const result = await generatePipelineConfig({
      ...baseRequest,
      provider: 'anthropic',
      model: 'nonexistent-model', // invalid → resolveModel throws
      // no apiKey → platform request
      fallbackProviders: ['openai'],
    });

    // Fallback still works for platform requests: served by openai's platform key.
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(result.servedBy).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' });
  });
});
