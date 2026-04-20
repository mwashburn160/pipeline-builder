# @pipeline-builder/ai-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Shared AI provider registry for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) — a self-service platform that turns TypeScript, a YAML config, or a single AI prompt into a production-ready AWS CodePipeline backed by 124 reusable, containerized plugins.

Lazily initializes SDK wrappers from environment variables and exposes model resolution helpers used by AI-assisted pipeline and plugin generation.

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

- `getAvailableProviders()` — Returns providers with configured env vars
- `getProviderModels(providerId)` — Returns model list from static catalog
- `resolveModel(providerId, modelId)` — Returns a `LanguageModel` from the registry
- `createModelWithKey(providerId, modelId, apiKey)` — Creates a temporary `LanguageModel` (not cached)

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

**Keywords:** aws, codepipeline, codebuild, cicd, ci-cd, devops, cdk, aws-cdk, cloudformation, pipeline, pipeline-as-code, containerized, docker, kubernetes, plugins, typescript, self-service, multi-tenant, compliance, automation, infrastructure-as-code, iac, cli
