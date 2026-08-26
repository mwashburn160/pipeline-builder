// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Types

/** Metadata for a single AI model. */
export interface AIModelInfo {
  /** Model identifier used in API calls (e.g. "claude-sonnet-5"). */
  id: string;
  /** Human-readable display name (e.g. "Claude Sonnet 5"). */
  name: string;
}

/** Metadata for an AI provider with its available models. */
export interface AIProviderInfo {
  /** Provider identifier (e.g. "anthropic", "openai", "google"). */
  id: string;
  /** Human-readable display name (e.g. "Anthropic"). */
  name: string;
  /** Models available for this provider. */
  models: AIModelInfo[];
}

// Catalog

/**
 * Standard AI provider catalog — single source of truth for all supported
 * providers and their models. Used by both backend services and frontend
 * components.
 */
export const AI_PROVIDER_CATALOG: Record<string, AIProviderInfo> = {
  'anthropic': {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  },
  'openai': {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    ],
  },
  'google': {
    id: 'google',
    name: 'Google',
    models: [
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
    ],
  },
  'xai': {
    id: 'xai',
    name: 'xAI (Grok)',
    models: [
      { id: 'grok-4.6', name: 'Grok 4.6' },
      { id: 'grok-4.5', name: 'Grok 4.5' },
      { id: 'grok-4.3', name: 'Grok 4.3' },
    ],
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    // Bedrock ids are region-scoped cross-region inference profiles; the `us.`
    // prefix targets US regions — swap the prefix (eu./apac./…) to match your
    // deploy region, and confirm availability in the Bedrock console.
    models: [
      { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5' },
      { id: 'us.amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
      { id: 'us.amazon.nova-lite-v1:0', name: 'Amazon Nova Lite' },
    ],
  },
};

/**
 * Environment variable names for each AI provider's API key.
 * Used by backend services to initialize the provider registry.
 */
export const AI_PROVIDER_ENV_VARS: Record<string, string> = {
  'anthropic': 'ANTHROPIC_API_KEY',
  'openai': 'OPENAI_API_KEY',
  'google': 'GOOGLE_GENERATIVE_AI_API_KEY',
  'xai': 'XAI_API_KEY',
  'amazon-bedrock': 'AWS_ACCESS_KEY_ID',
};

// Helpers

/**
 * Get the model list for a given provider ID.
 *
 * @param providerId - Provider identifier (e.g. "anthropic")
 * @returns Array of models, or empty array if the provider is unknown
 */
export function getAIProviderModels(providerId: string): AIModelInfo[] {
  return AI_PROVIDER_CATALOG[providerId]?.models ?? [];
}
