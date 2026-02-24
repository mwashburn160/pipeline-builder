/**
 * Unit tests for the shared AI provider catalog and helpers.
 *
 * @module test/ai-providers
 */

import {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_ENV_VARS,
  getAIProviderModels,
  getAIProviderName,
  type AIProviderInfo,
  type AIModelInfo,
} from '../src/constants/ai-providers';

// ---------------------------------------------------------------------------
// Catalog Structure
// ---------------------------------------------------------------------------

describe('AI_PROVIDER_CATALOG', () => {
  it('contains anthropic, openai, and google providers', () => {
    expect(AI_PROVIDER_CATALOG).toHaveProperty('anthropic');
    expect(AI_PROVIDER_CATALOG).toHaveProperty('openai');
    expect(AI_PROVIDER_CATALOG).toHaveProperty('google');
  });

  it('has exactly 3 providers', () => {
    expect(Object.keys(AI_PROVIDER_CATALOG)).toHaveLength(3);
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

// ---------------------------------------------------------------------------
// Environment Variable Mapping
// ---------------------------------------------------------------------------

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
  });
});

// ---------------------------------------------------------------------------
// getAIProviderModels
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getAIProviderName
// ---------------------------------------------------------------------------

describe('getAIProviderName', () => {
  it('returns display name for valid providers', () => {
    expect(getAIProviderName('anthropic')).toBe('Anthropic');
    expect(getAIProviderName('openai')).toBe('OpenAI');
    expect(getAIProviderName('google')).toBe('Google');
  });

  it('falls back to raw ID for unknown provider', () => {
    expect(getAIProviderName('unknown-provider')).toBe('unknown-provider');
  });
});
