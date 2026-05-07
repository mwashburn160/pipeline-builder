// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_ENV_VARS,
  getAIProviderModels,
  type AIProviderInfo,
  type AIModelInfo,
} from '@pipeline-builder/api-core';
import type { LanguageModel } from 'ai';

// Provider Registry

/** Registered provider with model factory function. */
export interface ProviderEntry {
  info: AIProviderInfo;
  createModel: (modelId: string) => LanguageModel;
}

const registry = new Map<string, ProviderEntry>();
let initialized = false;

/**
 * Lazily initialize the provider registry from environment variables.
 * Only providers with configured API keys are registered.
 */
function initRegistry(): void {
  if (initialized) return;
  initialized = true;

  // Bedrock authenticates via the IAM role attached to the runtime (no key
  // is passed); other providers take an API key. The factory signature
  // accepts an optional key so both shapes share one type.
  const factories: Record<string, (key?: string) => (modelId: string) => LanguageModel> = {
    'anthropic': (key) => createAnthropic({ apiKey: key }),
    'openai': (key) => createOpenAI({ apiKey: key }),
    'google': (key) => createGoogleGenerativeAI({ apiKey: key }),
    'xai': (key) => createXai({ apiKey: key }),
    'amazon-bedrock': () => createAmazonBedrock(),
  };

  for (const [id, info] of Object.entries(AI_PROVIDER_CATALOG)) {
    const envVar = AI_PROVIDER_ENV_VARS[id];
    const apiKey = envVar ? process.env[envVar] : undefined;
    if (apiKey && factories[id]) {
      const provider = factories[id](apiKey);
      registry.set(id, { info, createModel: provider });
    }
  }
}

/**
 * Returns the list of providers that have API keys configured via env vars.
 *
 * @returns Array of configured provider info with model lists
 */
export function getAvailableProviders(): AIProviderInfo[] {
  initRegistry();
  return Array.from(registry.values()).map((e) => e.info);
}

/**
 * Returns the model list for a given provider ID (regardless of env var config).
 *
 * @param providerId - Provider identifier
 * @returns Array of models, or empty array if provider is unknown
 */
export function getProviderModels(providerId: string): AIModelInfo[] {
  return getAIProviderModels(providerId);
}

/**
 * Resolve a LanguageModel from the registry for a configured provider.
 *
 * @param providerId - Provider identifier
 * @param modelId - Model identifier
 * @returns LanguageModel instance
 * @throws Error if provider is not configured or model is invalid
 */
export function resolveModel(providerId: string, modelId: string): LanguageModel {
  initRegistry();
  const entry = registry.get(providerId);
  if (!entry) {
    throw new Error(`AI provider "${providerId}" is not configured. Set the corresponding API key environment variable.`);
  }
  if (!entry.info.models.some((m) => m.id === modelId)) {
    const available = entry.info.models.map((m) => m.id).join(', ');
    throw new Error(`Model "${modelId}" is not available for provider "${providerId}". Available models: ${available}`);
  }
  return entry.createModel(modelId);
}

/**
 * Create a temporary LanguageModel using a custom API key (not cached in registry).
 *
 * @param providerId - Provider identifier
 * @param modelId - Model identifier
 * @param apiKey - Custom API key
 * @returns LanguageModel instance
 * @throws Error if provider or model is unknown
 */
export function createModelWithKey(providerId: string, modelId: string, apiKey: string): LanguageModel {
  const models = getAIProviderModels(providerId);
  if (models.length === 0) {
    throw new Error(`Unknown AI provider "${providerId}". Supported: ${Object.keys(AI_PROVIDER_CATALOG).join(', ')}`);
  }
  if (!models.some((m) => m.id === modelId)) {
    throw new Error(`Model "${modelId}" is not available for provider "${providerId}". Available: ${models.map((m) => m.id).join(', ')}`);
  }

  switch (providerId) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'xai':
      return createXai({ apiKey })(modelId);
    case 'amazon-bedrock':
      return createAmazonBedrock()(modelId);
    default:
      throw new Error(`Unsupported AI provider "${providerId}"`);
  }
}
