// Types

/** Metadata for a single AI model. */
export interface AIModelInfo {
  /** Model identifier used in API calls (e.g. "claude-sonnet-4-20250514"). */
  id: string;
  /** Human-readable display name (e.g. "Claude Sonnet 4"). */
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
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  },
  'openai': {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
  'google': {
    id: 'google',
    name: 'Google',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.5-pro-preview-06-05', name: 'Gemini 2.5 Pro' },
    ],
  },
  'xai': {
    id: 'xai',
    name: 'xAI (Grok)',
    models: [
      { id: 'grok-3', name: 'Grok 3' },
      { id: 'grok-3-fast', name: 'Grok 3 Fast' },
      { id: 'grok-3-mini', name: 'Grok 3 Mini' },
    ],
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    models: [
      { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2' },
      { id: 'us.amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
      { id: 'us.amazon.nova-lite-v1:0', name: 'Amazon Nova Lite' },
    ],
  },
  'ollama': {
    id: 'ollama',
    name: 'Ollama (Local)',
    models: [
      { id: 'llama3', name: 'Llama 3' },
      { id: 'llama3:70b', name: 'Llama 3 70B' },
      { id: 'codellama', name: 'Code Llama' },
      { id: 'mistral', name: 'Mistral' },
      { id: 'deepseek-coder-v2', name: 'DeepSeek Coder V2' },
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
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
  'ollama': 'OLLAMA_BASE_URL',
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

/**
 * Get the display name for a provider ID.
 *
 * @param providerId - Provider identifier (e.g. "anthropic")
 * @returns Display name, or the raw ID if the provider is unknown
 */
export function getAIProviderName(providerId: string): string {
  return AI_PROVIDER_CATALOG[providerId]?.name ?? providerId;
}
