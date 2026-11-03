// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI provider + model catalog, as DATA ONLY.
 *
 * Dependency-free and env-free so the browser imports it directly
 * (`@pipeline-builder/api-core/ai-catalog`) — the frontend's model picker and the
 * backend's provider registry read the one list, instead of the frontend keeping a
 * hand-maintained mirror that drifted every time a model shipped. Anything that
 * reads the environment (the OpenAI-compatible endpoint, provider key env vars)
 * stays in `constants/ai-providers.ts`, which re-exports this.
 */

/** Metadata for a single AI model. */
export interface AIModelInfo {
  /** Model identifier used in API calls (e.g. "claude-sonnet-5-5"). */
  id: string;
  /** Human-readable display name (e.g. "Claude Sonnet 5.5"). */
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

/**
 * Standard AI provider catalog — single source of truth for all supported
 * providers and their models. The FIRST model of a provider is its default
 * (what a provider-only request resolves to), so order matters.
 */
export const AI_PROVIDER_CATALOG: Record<string, AIProviderInfo> = {
  'anthropic': {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
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
      { id: 'us.anthropic.claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'us.anthropic.claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5' },
      { id: 'us.amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
    ],
  },
};

/** Display names by provider id — the catalog's names, for UI surfaces that list providers. */
export const AI_PROVIDER_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(AI_PROVIDER_CATALOG).map((p) => [p.id, p.name]),
);

/** Model lists by provider id — the catalog's models, for UI surfaces that need only those. */
export const AI_PROVIDER_MODELS: Record<string, AIModelInfo[]> = Object.fromEntries(
  Object.values(AI_PROVIDER_CATALOG).map((p) => [p.id, p.models]),
);
