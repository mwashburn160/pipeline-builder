// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A BYO (bring-your-own) AI key must NEVER fall back to a platform-configured
 * provider key — neither at RESOLUTION (an unknown model on the caller's key) nor
 * at RUN time (a retryable provider failure). Either would silently spend the
 * platform's AI budget on a request the caller intended to bill to their own key.
 * A BYO failure is terminal; a NON-BYO (platform) request still falls back.
 *
 * Exercised through the route's real seam, `GenerationRun.run` →
 * `resolveOrgModelSelection` + `runWithFailover`, over the REAL ai-core registry.
 * The registry is env-driven and memoized on first use, so BOTH keys are set
 * BEFORE importing — the fallback provider (openai) is genuinely available,
 * proving the guard suppresses a fallback that WOULD otherwise succeed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
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
  tool: (def: unknown) => def,
  generateObject: jest.fn<AnyFn>(),
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

const AI_CATALOG = {
  anthropic: { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 4' }] },
  openai: { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] },
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  AI_PROVIDER_CATALOG: AI_CATALOG,
  AI_PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' },
  getAIProviderModels: jest.fn((id: string) => (AI_CATALOG as any)[id]?.models ?? []),
  // The org has AI on and configured no key of its own — the platform key applies.
  assertOrgAIEnabled: async () => ({ aiEnabled: true, providers: [] }),
  fetchOrgAIKey: async () => { throw new Error('no org key'); },
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  observe: () => undefined,
}));

const mockResolvableListings = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const tx = { select: jest.fn<AnyFn>().mockReturnThis(), from: jest.fn<AnyFn>().mockReturnThis(), where: jest.fn<(...a: any[]) => any>().mockResolvedValue([]) };
  return stubModule('@pipeline-builder/pipeline-data', {
    db: tx,
    schema: { plugin: {} },
    withTenantTx: (fn: (t: typeof tx) => unknown) => fn(tx),
    // Visibility-ladder predicate pieces plugin-lookup-service links against.
    // Listing resolution: no listings unless a test sets some.
    OFFICIAL_PUBLISHER_HANDLE: 'pipeline-builder',
    drizzleListingSource: () => ({ liveListings: async () => [], publishersByIds: async () => [] }),
    getTenantContext: () => undefined,
    runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
    resolvableListings: (...a: unknown[]) => mockResolvableListings(...a),
    buildPluginConditions: () => [],
    withViewerContext: (f: unknown) => f,
  });
});

const { GenerationRun } = await import('../src/services/ai-generation-run.js');

const newRun = () => new GenerationRun({ route: 'generate', orgId: 'test-org', userId: 'u-1', promptLength: 16, log: () => undefined });
/** A provider failure worth failing over for (overloaded), before any response. */
const overloaded = () => Object.assign(new Error('overloaded'), { statusCode: 529 });

describe('BYO key must not fall back to platform provider keys', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('BYO key + unknown model + fallback available → throws, never resolves the platform fallback', async () => {
    const attempt = jest.fn<AnyFn>();

    await expect(newRun().run({
      provider: 'anthropic',
      model: 'nonexistent-model', // invalid on the caller's key
      apiKey: 'caller-byo-key',
      fallbackProviders: ['openai'], // WOULD resolve via the platform OPENAI_API_KEY
    }, attempt)).rejects.toThrow(/not available for provider/);

    // No attempt ran — no provider round-trip happened on anyone's key.
    expect(attempt).not.toHaveBeenCalled();
  });

  it('NON-BYO (platform) request with the same failure DOES fall back to the platform provider', async () => {
    const attempt = jest.fn(async (selection: { provider: string; modelId: string }) => selection);

    const served = await newRun().run({ provider: 'anthropic', model: 'nonexistent-model', fallbackProviders: ['openai'] }, attempt);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(served).toMatchObject({ provider: 'openai', modelId: 'gpt-5.6-sol', keySource: 'platform', fallbackFrom: 'anthropic' });
  });

  it('a BYO call that fails retryably is NOT re-run on the platform key', async () => {
    const attempt = jest.fn<AnyFn>().mockRejectedValue(overloaded());

    await expect(newRun().run({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'caller-byo-key', fallbackProviders: ['openai'] }, attempt))
      .rejects.toThrow('overloaded');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('a platform call that fails retryably BEFORE responding fails over to the next provider', async () => {
    const attempt = jest.fn<AnyFn>()
      .mockRejectedValueOnce(overloaded())
      .mockImplementationOnce(async (selection: { provider: string }) => selection.provider);
    const run = newRun();

    await expect(run.run({ provider: 'anthropic', model: 'claude-sonnet-5', fallbackProviders: ['openai'] }, attempt)).resolves.toBe('openai');
    expect(run.served).toMatchObject({ provider: 'openai', fallbackFrom: 'anthropic' });
  });

  it('a platform call that fails AFTER the provider responded is final — the paid work is not repeated', async () => {
    const run = newRun();
    const attempt = jest.fn<AnyFn>().mockImplementation(async () => {
      run.markResponded();
      throw overloaded();
    });

    await expect(run.run({ provider: 'anthropic', model: 'claude-sonnet-5', fallbackProviders: ['openai'] }, attempt)).rejects.toThrow('overloaded');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
