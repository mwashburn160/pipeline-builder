// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createModelWithKey, getAvailableProviders, getProviderModels, resolveModel } from '@pipeline-builder/ai-core';
import type { LanguageModel } from '@pipeline-builder/ai-core';

/**
 * Resolve a LanguageModel for a request:
 * - `provider` + `model` → use them (with an optional ephemeral BYO key);
 * - `provider` only → the provider's first configured model;
 * - `model` only → error (ambiguous — the provider is unknown);
 * - neither → the first env-configured provider (a cloud key or the local
 *   OpenAI-compatible endpoint) so the assistant works out of the box.
 *
 * @throws Error on a model-without-provider request, or when nothing is configured
 */
export function resolveAskModel(provider?: string, model?: string, apiKey?: string): LanguageModel {
  if (provider) {
    // Default to the provider's first model when the caller named a provider but no model.
    const resolvedModel = model ?? getProviderModels(provider)[0]?.id;
    if (!resolvedModel) {
      throw new Error(`AI provider "${provider}" has no configured models.`);
    }
    return apiKey ? createModelWithKey(provider, resolvedModel, apiKey) : resolveModel(provider, resolvedModel);
  }
  if (model) {
    throw new Error('A `model` was supplied without a `provider` — specify both, or neither.');
  }
  const providers = getAvailableProviders();
  if (providers.length === 0 || providers[0].models.length === 0) {
    throw new Error('AI is not configured: no provider API key is set and OPENAI_COMPATIBLE_BASE_URL is unset.');
  }
  const p = providers[0];
  return resolveModel(p.id, p.models[0].id);
}
