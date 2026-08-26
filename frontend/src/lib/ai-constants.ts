// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module lib/ai-constants
 * @description Shared AI provider constants for frontend components.
 *
 * AIPluginBuilderTab and other AI surfaces use these for provider display
 * names and org-level model catalogs.
 * This is the frontend counterpart to the backend's `AI_PROVIDER_CATALOG`
 * in api-core.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Model metadata used in provider dropdowns. */
export interface AIModelInfo {
  id: string;
  name: string;
}

/**
 * Provider info as seen by frontend components.
 * Includes a `source` field indicating whether the provider is configured
 * via server env vars, per-organization API keys, or not configured at all.
 */
export interface AIProviderInfo {
  id: string;
  name: string;
  source: 'server' | 'org' | 'none';
  models: AIModelInfo[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Standard model lists for all known providers.
 *
 * When a provider is configured via organization settings (not server env vars),
 * the backend doesn't return a model list. This catalog provides the models
 * so the frontend can still offer model selection. Also used as the fallback
 * catalog when providers aren't configured (source: 'none').
 */
export const ORG_PROVIDER_MODELS: Record<string, AIModelInfo[]> = {
  anthropic: [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  ],
  google: [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  ],
  xai: [
    { id: 'grok-4.6', name: 'Grok 4.6' },
    { id: 'grok-4.5', name: 'Grok 4.5' },
    { id: 'grok-4.3', name: 'Grok 4.3' },
  ],
  'amazon-bedrock': [
    // `us.` = US cross-region inference profile; swap for your deploy region.
    { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5' },
    { id: 'us.amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
    { id: 'us.amazon.nova-lite-v1:0', name: 'Amazon Nova Lite' },
  ],
};

/**
 * Display names for AI provider IDs.
 * Used when constructing org-level or unconfigured provider entries.
 */
export const AI_PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI (Grok)',
  'amazon-bedrock': 'Amazon Bedrock',
};

/**
 * Returns a display label for a provider's source/configuration status.
 */
export function getProviderSourceLabel(provider: AIProviderInfo): string {
  if (provider.source === 'none') return 'API key required';
  return provider.source;
}
