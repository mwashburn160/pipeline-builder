# @pipeline-builder/ai-core

Shared AI provider registry for the pipeline-builder platform. Lazily initializes SDK wrappers from environment variables and exposes model resolution helpers.

## Supported Providers

| Provider | Env Variable | SDK |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `@ai-sdk/anthropic` |
| OpenAI | `OPENAI_API_KEY` | `@ai-sdk/openai` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | `@ai-sdk/google` |
| xAI (Grok) | `XAI_API_KEY` | `@ai-sdk/xai` |
| Amazon Bedrock | `AWS_ACCESS_KEY_ID` | `@ai-sdk/amazon-bedrock` |

## Usage

```typescript
import {
  getAvailableProviders,
  getProviderModels,
  resolveModel,
  createModelWithKey,
} from '@pipeline-builder/ai-core';

// List providers with configured API keys
const providers = getAvailableProviders();

// Get models for a provider (static catalog, no env vars needed)
const models = getProviderModels('anthropic');

// Resolve a model from the registry (requires env var)
const model = resolveModel('anthropic', 'claude-sonnet-4-20250514');

// Create a one-off model with a custom API key
const custom = createModelWithKey('openai', 'gpt-4o', 'sk-...');
```

## API

- `getAvailableProviders()` - Returns providers with configured env vars
- `getProviderModels(providerId)` - Returns model list from static catalog
- `resolveModel(providerId, modelId)` - Returns a `LanguageModel` from the registry
- `createModelWithKey(providerId, modelId, apiKey)` - Creates a temporary `LanguageModel` (not cached)
