// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AI_PROVIDER_CATALOG, type AIModelInfo, type AIProviderInfo } from '../types/ai-catalog.js';

// The catalog itself is data-only and lives in `types/ai-catalog.ts` (the
// browser-safe `./ai-catalog` subpath); re-exported here so server code keeps one
// import site for everything AI-provider.
export { AI_PROVIDER_CATALOG, AI_PROVIDER_NAMES, AI_PROVIDER_MODELS } from '../types/ai-catalog.js';
export type { AIModelInfo, AIProviderInfo } from '../types/ai-catalog.js';

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

/**
 * Provider id for a self-hosted, OpenAI-compatible endpoint — a Docker model image
 * (Ollama, Docker Model Runner, vLLM) or any other server that speaks the OpenAI
 * chat API. Unlike the fixed providers above, this one is NOT in the static catalog:
 * its endpoint and model list are deployment-defined and resolved from env at
 * runtime by {@link getOpenAICompatibleProvider}.
 */
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

/**
 * Parse a `id[|Display Name][,id2[|Name2]]` env string into model metadata. The
 * id/name separator is `|` (NOT `:`) because model ids commonly contain colons —
 * e.g. Ollama tags (`qwen2.5-coder:7b`) and Bedrock inference profiles.
 */
function parseModelList(raw: string): AIModelInfo[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf('|');
      const id = (idx === -1 ? entry : entry.slice(0, idx)).trim();
      const name = (idx === -1 ? '' : entry.slice(idx + 1)).trim() || id;
      return { id, name };
    })
    .filter((m) => m.id.length > 0);
}

/**
 * Resolve the OpenAI-compatible (local / self-hosted) provider from env, or `null`
 * when no endpoint is configured. Enabled by `OPENAI_COMPATIBLE_BASE_URL`; the model
 * list comes from `OPENAI_COMPATIBLE_MODELS` (comma list of `id[|Display Name]`),
 * falling back to `OPENAI_COMPATIBLE_MODEL`, then a generic `local` id. The display
 * name is overridable via `OPENAI_COMPATIBLE_NAME`.
 *
 * @returns Provider info for the configured local endpoint, or null if unset
 */
export function getOpenAICompatibleProvider(): AIProviderInfo | null {
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (!baseURL) return null;
  const raw = process.env.OPENAI_COMPATIBLE_MODELS ?? process.env.OPENAI_COMPATIBLE_MODEL ?? 'local|Local model';
  const models = parseModelList(raw);
  return {
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: process.env.OPENAI_COMPATIBLE_NAME || 'Local model (OpenAI-compatible)',
    models: models.length > 0 ? models : [{ id: 'local', name: 'Local model' }],
  };
}

// Helpers

/**
 * Get the model list for a given provider ID.
 *
 * @param providerId - Provider identifier (e.g. "anthropic")
 * @returns Array of models, or empty array if the provider is unknown
 */
export function getAIProviderModels(providerId: string): AIModelInfo[] {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return getOpenAICompatibleProvider()?.models ?? [];
  }
  return AI_PROVIDER_CATALOG[providerId]?.models ?? [];
}
