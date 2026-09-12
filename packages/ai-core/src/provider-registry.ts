// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_ENV_VARS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  getAIProviderModels,
  getOpenAICompatibleProvider,
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

// Provider → model-factory map. `key` is optional so keyless providers (Bedrock,
// via the runtime IAM role) and key-based providers share one signature. Declared
// once and consumed by BOTH initRegistry and createModelWithKey.
const PROVIDER_FACTORIES: Record<string, (key?: string) => (modelId: string) => LanguageModel> = {
  'anthropic': (key) => createAnthropic({ apiKey: key }),
  'openai': (key) => createOpenAI({ apiKey: key }),
  'google': (key) => createGoogleGenerativeAI({ apiKey: key }),
  'xai': (key) => createXai({ apiKey: key }),
  // Bedrock authenticates with the RUNTIME's IAM role, and the ai-sdk provider
  // does NOT walk the AWS credential chain on its own — bare `createAmazonBedrock()`
  // reads only `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and otherwise throws
  // "AWS SigV4 authentication requires AWS credentials" at call time. Handing it
  // the standard chain resolves EKS Pod Identity, IRSA, ECS task roles, the EC2
  // instance profile, SSO and static env keys — i.e. every way this platform is
  // actually deployed. Built once per factory call; the chain caches internally
  // and refreshes expiring role credentials on its own.
  'amazon-bedrock': () => createAmazonBedrock({ credentialProvider: fromNodeProviderChain() }),
  // Self-hosted OpenAI-compatible endpoint (Docker model image / Ollama / vLLM).
  // The endpoint is deployment-defined via OPENAI_COMPATIBLE_BASE_URL; local servers
  // usually ignore the key, so a placeholder is sent when none is configured.
  [OPENAI_COMPATIBLE_PROVIDER_ID]: (key) => {
    const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
    if (!baseURL) {
      throw new Error('OPENAI_COMPATIBLE_BASE_URL is not set; cannot build the local (OpenAI-compatible) provider.');
    }
    const provider = createOpenAICompatible({
      name: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseURL,
      apiKey: key ?? process.env.OPENAI_COMPATIBLE_API_KEY ?? 'not-needed',
    });
    return (modelId: string) => provider(modelId);
  },
};

/** Providers that authenticate WITHOUT an API key (Bedrock uses the IAM role). */
const KEYLESS_PROVIDERS = new Set(['amazon-bedrock']);

/**
 * Whether the runtime has an AWS credential SOURCE the provider chain can
 * actually resolve.
 *
 * A configured region is NOT such a signal: every deploy target sets
 * `AWS_REGION` (it is needed for pipeline synthesis), including minikube and
 * docker-compose, where nothing grants the pod AWS credentials. Gating Bedrock
 * on the region alone therefore advertised it on local installs as the ONLY
 * provider, `resolveAskModel` picked it as the default, and every Ask turn died
 * with "Could not load credentials from any providers" — an error about AWS
 * that has nothing to do with what the user asked.
 *
 * Each check below corresponds to a way `fromNodeProviderChain()` can succeed:
 *   - static keys in the environment;
 *   - EKS Pod Identity / ECS task role (the agent injects a credentials URI);
 *   - IRSA (a projected web-identity token file);
 *   - a shared-config profile, for a developer running against real AWS.
 *
 * The EC2 instance profile is the one case with NO environment marker — its
 * credentials come from IMDS at call time — so it takes the explicit
 * `BEDROCK_ENABLED=true` opt-in rather than being guessed at.
 */
function awsCredentialSourceConfigured(): boolean {
  return !!(
    process.env.AWS_ACCESS_KEY_ID
    || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
    || process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    || process.env.AWS_PROFILE
    || process.env.BEDROCK_ENABLED === 'true'
  );
}

/**
 * Whether a keyless provider (Bedrock) should be advertised. It authenticates
 * with the runtime's IAM role rather than an API key, so it needs BOTH a region
 * to call and a resolvable credential source — see
 * {@link awsCredentialSourceConfigured} for why the region alone is not enough.
 */
function keylessProviderAvailable(): boolean {
  return !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) && awsCredentialSourceConfigured();
}

/**
 * Lazily initialize the provider registry from environment variables. Key-based
 * providers register only when their key is set; keyless providers (Bedrock)
 * register when an AWS region is configured.
 */
function initRegistry(): void {
  if (initialized) return;
  initialized = true;

  for (const [id, info] of Object.entries(AI_PROVIDER_CATALOG)) {
    const factory = PROVIDER_FACTORIES[id];
    if (!factory) continue;
    const envVar = AI_PROVIDER_ENV_VARS[id];
    const apiKey = envVar ? process.env[envVar] : undefined;
    // A keyless provider is gated SOLELY by its own availability check — never
    // by the presence of `envVar`. Bedrock's mapped env var is
    // `AWS_ACCESS_KEY_ID`, so the key path would otherwise register it whenever
    // static keys exist, skipping the region requirement and producing a
    // provider that fails at call time for want of a region.
    const usable = KEYLESS_PROVIDERS.has(id) ? keylessProviderAvailable() : !!apiKey;
    if (usable) {
      registry.set(id, { info, createModel: factory(apiKey) });
    }
  }

  // The OpenAI-compatible (local / self-hosted) provider is not in the static
  // catalog — its endpoint and models are deployment-defined. Register it when a
  // base URL is configured; its "is configured" signal is the base URL, not a key.
  const compat = getOpenAICompatibleProvider();
  if (compat) {
    registry.set(compat.id, {
      info: compat,
      createModel: PROVIDER_FACTORIES[OPENAI_COMPATIBLE_PROVIDER_ID](process.env.OPENAI_COMPATIBLE_API_KEY),
    });
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

  const factory = PROVIDER_FACTORIES[providerId];
  if (!factory) throw new Error(`Unsupported AI provider "${providerId}"`);

  // Keyless providers (Bedrock) authenticate via the runtime IAM role and IGNORE a
  // supplied key. Silently dropping the key and returning a model would defer the
  // failure to model-call time when the IAM role/region isn't configured; guard it
  // here so the failure is clear at config time (mirrors resolveModel's gate).
  if (KEYLESS_PROVIDERS.has(providerId)) {
    if (!keylessProviderAvailable()) {
      throw new Error(
        `AI provider "${providerId}" authenticates via the AWS IAM role (the API key is ignored); ` +
          'set AWS_REGION (or AWS_DEFAULT_REGION) so the runtime credentials can be resolved.',
      );
    }
    return factory()(modelId);
  }
  return factory(apiKey)(modelId);
}
