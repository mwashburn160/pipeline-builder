// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_ENV_VARS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  getAIProviderModels,
  getOpenAICompatibleProvider,
  type AIProviderInfo,
  type AIModelInfo,
} from '../src/constants/ai-providers.js';

// Catalog Structure

describe('AI_PROVIDER_CATALOG', () => {
  it('contains all supported providers', () => {
    expect(AI_PROVIDER_CATALOG).toHaveProperty('anthropic');
    expect(AI_PROVIDER_CATALOG).toHaveProperty('openai');
    expect(AI_PROVIDER_CATALOG).toHaveProperty('google');
    expect(AI_PROVIDER_CATALOG).toHaveProperty('xai');
    expect(AI_PROVIDER_CATALOG).toHaveProperty('amazon-bedrock');
  });

  it('has exactly 5 providers', () => {
    expect(Object.keys(AI_PROVIDER_CATALOG)).toHaveLength(5);
  });

  it.each(Object.entries(AI_PROVIDER_CATALOG))(
    '%s has valid structure',
    (id, info: AIProviderInfo) => {
      expect(info.id).toBe(id);
      expect(typeof info.name).toBe('string');
      expect(info.name.length).toBeGreaterThan(0);
      expect(Array.isArray(info.models)).toBe(true);
      expect(info.models.length).toBeGreaterThan(0);
    },
  );

  it.each(Object.values(AI_PROVIDER_CATALOG).flatMap((p) => p.models))(
    'model "$id" has non-empty id and name',
    (model: AIModelInfo) => {
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.name).toBe('string');
      expect(model.name.length).toBeGreaterThan(0);
    },
  );

  it('provider IDs are lowercase', () => {
    for (const id of Object.keys(AI_PROVIDER_CATALOG)) {
      expect(id).toBe(id.toLowerCase());
    }
  });
});

// Environment Variable Mapping

describe('AI_PROVIDER_ENV_VARS', () => {
  it('has entries for all catalog providers', () => {
    for (const id of Object.keys(AI_PROVIDER_CATALOG)) {
      expect(AI_PROVIDER_ENV_VARS).toHaveProperty(id);
      expect(typeof AI_PROVIDER_ENV_VARS[id]).toBe('string');
      expect(AI_PROVIDER_ENV_VARS[id].length).toBeGreaterThan(0);
    }
  });

  it('maps to expected env var names', () => {
    expect(AI_PROVIDER_ENV_VARS.anthropic).toBe('ANTHROPIC_API_KEY');
    expect(AI_PROVIDER_ENV_VARS.openai).toBe('OPENAI_API_KEY');
    expect(AI_PROVIDER_ENV_VARS.google).toBe('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(AI_PROVIDER_ENV_VARS.xai).toBe('XAI_API_KEY');
    expect(AI_PROVIDER_ENV_VARS['amazon-bedrock']).toBe('AWS_ACCESS_KEY_ID');
  });
});

// getAIProviderModels

describe('getAIProviderModels', () => {
  it('returns models for a valid provider', () => {
    const models = getAIProviderModels('anthropic');
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('id');
    expect(models[0]).toHaveProperty('name');
  });

  it('returns empty array for unknown provider', () => {
    expect(getAIProviderModels('nonexistent')).toEqual([]);
  });

  it('returns the same models as the catalog', () => {
    for (const [id, info] of Object.entries(AI_PROVIDER_CATALOG)) {
      expect(getAIProviderModels(id)).toEqual(info.models);
    }
  });
});

// getOpenAICompatibleProvider (deployment-defined local endpoint)

describe('getOpenAICompatibleProvider', () => {
  const keys = [
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_MODELS',
    'OPENAI_COMPATIBLE_MODEL',
    'OPENAI_COMPATIBLE_NAME',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns null when no base URL is configured', () => {
    expect(getOpenAICompatibleProvider()).toBeNull();
    expect(getAIProviderModels(OPENAI_COMPATIBLE_PROVIDER_ID)).toEqual([]);
  });

  it('is NOT part of the static catalog', () => {
    expect(AI_PROVIDER_CATALOG).not.toHaveProperty(OPENAI_COMPATIBLE_PROVIDER_ID);
  });

  it('parses id[|name] model entries and honors the name override', () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://ask-model:12434/v1';
    process.env.OPENAI_COMPATIBLE_MODELS = 'qwen2.5-coder|Qwen 2.5 Coder, llama3.3';
    process.env.OPENAI_COMPATIBLE_NAME = 'On-prem model';

    const provider = getOpenAICompatibleProvider();
    expect(provider).toEqual({
      id: OPENAI_COMPATIBLE_PROVIDER_ID,
      name: 'On-prem model',
      models: [
        { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
        { id: 'llama3.3', name: 'llama3.3' },
      ],
    });
    // getAIProviderModels routes through the dynamic resolver for this provider id
    expect(getAIProviderModels(OPENAI_COMPATIBLE_PROVIDER_ID)).toEqual(provider!.models);
  });

  it('defaults to a single "local" model when only a base URL is set', () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://ask-model:12434/v1';
    expect(getOpenAICompatibleProvider()!.models).toEqual([{ id: 'local', name: 'Local model' }]);
  });
});
