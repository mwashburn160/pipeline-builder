# @pipeline-builder/ai-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Shared AI provider registry for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): lazily initialized SDK wrappers for Anthropic, OpenAI, Google, xAI, and Bedrock used by AI-assisted pipeline and plugin generation.

> Internal workspace package — consumed by other packages via `workspace:*`. **ESM only** (the `ai` SDK v6 is ESM-only).

## Responsibilities

- Lazily initializes a registry of AI SDK provider wrappers from environment variables — only providers with a configured API key are registered.
- Resolves a Vercel AI SDK `LanguageModel` for a given provider + model, validating against the static provider catalog.
- Supports a one-off model created from a caller-supplied API key (not cached in the registry).
- Re-exports the `ai` SDK helpers consumers need so they don't add a separate dependency.

Providers and their env vars: Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`), Google (`GOOGLE_GENERATIVE_AI_API_KEY`), xAI (`XAI_API_KEY`), and Amazon Bedrock (authenticates via the runtime IAM role).

## Key exports

| Export | Purpose |
|---|---|
| `getAvailableProviders()` | Returns provider info for providers with a configured API key |
| `getProviderModels(providerId)` | Returns the model list for a provider from the static catalog (no env var needed) |
| `resolveModel(providerId, modelId)` | Returns a `LanguageModel` from the registry; throws if the provider is unconfigured or the model is unknown |
| `createModelWithKey(providerId, modelId, apiKey)` | Creates a one-off `LanguageModel` from a custom key (not cached) |
| `ProviderEntry` (type) | A registered provider: its info plus a `createModel` factory |
| `LanguageModel` (type), `generateText`, `streamText`, `Output` | Re-exported from the [`ai`](https://www.npmjs.com/package/ai) SDK |

## Usage

```typescript
import { resolveModel, generateText } from '@pipeline-builder/ai-core';

const model = resolveModel('anthropic', 'claude-sonnet-4-20250514');
const { text } = await generateText({ model, prompt: 'Generate a pipeline spec…' });
```

## Development

```bash
pnpm build   # projen build (compile + lint + test + package)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
