/**
 * @module lib/ai-constants
 * @description Shared AI provider constants for frontend components.
 *
 * Both {@link AIBuilderTab} (pipeline) and {@link AIPluginBuilderTab} (plugin)
 * use these constants for provider display names and org-level model catalogs.
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
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
  ],
  google: [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.5-pro-preview-06-05', name: 'Gemini 2.5 Pro' },
  ],
  xai: [
    { id: 'grok-3', name: 'Grok 3' },
    { id: 'grok-3-fast', name: 'Grok 3 Fast' },
    { id: 'grok-3-mini', name: 'Grok 3 Mini' },
  ],
  'amazon-bedrock': [
    { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2' },
    { id: 'us.amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
    { id: 'us.amazon.nova-lite-v1:0', name: 'Amazon Nova Lite' },
  ],
  ollama: [
    { id: 'tinyllama', name: 'TinyLlama (1.1B)' },
    { id: 'phi3:mini', name: 'Phi-3 Mini (3.8B)' },
    { id: 'llama3', name: 'Llama 3 (8B)' },
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
  ollama: 'Ollama (Local)',
};

/**
 * Returns a display label for a provider's source/configuration status.
 */
export function getProviderSourceLabel(provider: AIProviderInfo): string {
  if (provider.id === 'ollama' && provider.source !== 'none') return 'No API key needed';
  if (provider.source === 'none') return 'API key required';
  return provider.source;
}
