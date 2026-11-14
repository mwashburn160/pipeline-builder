# @pipeline-builder/ai-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Shared AI provider registry for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): lazily initialized SDK wrappers for Anthropic, OpenAI, Google, xAI, and Bedrock used by AI-assisted pipeline and plugin generation.

> Internal workspace package — consumed by other packages via `workspace:*`. **ESM only** (the `ai` SDK v6 is ESM-only).

## Responsibilities

- Lazily initializes a registry of AI SDK provider wrappers from environment variables — only providers with a configured API key are registered.
- Resolves a Vercel AI SDK `LanguageModel` for a given provider + model, validating against the static provider catalog.
- Resolves a request against a caller-supplied (BYO) or org-owned key without caching it in the registry, and never falls back from such a key to the platform's.
- Holds the per-call policy (timeouts, caps, retries, prompt caching, platform failover) and the "Ask" how-to agent.
- Re-exports the `ai` SDK helpers consumers need so they don't add a separate dependency.

Providers and their env vars: Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`), Google (`GOOGLE_GENERATIVE_AI_API_KEY`), xAI (`XAI_API_KEY`), and Amazon Bedrock (authenticates via the runtime IAM role).

## Key exports

Everything below is exported from the package root (`src/index.ts`); nothing else is public.

| Export | Purpose |
|---|---|
| `getAvailableProviders()` | Provider info for the providers with a configured API key |
| `getProviderModels(providerId)` | The model list for a provider, from the static catalog (no env var needed) |
| `resolveModel(providerId, modelId)` | A `LanguageModel` from the registry; throws if the provider is unconfigured or the model is unknown |
| `resolveModelSelection(selection)` | Resolve a request's `{ provider?, model?, apiKey?, fallbacks? }` to a `ResolvedModelSelection` (model, provider, modelId, whose key pays). A bring-your-own key never falls back to the platform's keys |
| `resolveOrgModelSelection(selection, deps?)` | The org-aware resolver: request BYO key, then the org's own provider key, then the platform key — honouring the org's AI switch (`AIDisabledError`) and never silently downgrading to the platform key |
| `aiCallSettings(opts)` | The per-call policy every AI entry point shares: abort signal / timeout, output-token cap, retries and temperature (`AI_REQUEST_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_MAX_RETRIES`, `aiCallSignal`, `capOutputTokens`, `samplingTemperature` are its parts) |
| `runWithFailover(selection, attempt, opts?)` | Run one AI call, failing over along `platformFailoverChain()` on a retryable error (`isRetryableAIError`) — platform-key selections only |
| `cachedSystemPrompt`, `asPromptData`, `asPromptDataBlock` | Prompt caching for the system prompt, and fencing untrusted data into a prompt |
| `tokenUsage`, `aiUsageAuditDetails` | Normalized token usage and the audit-row details for an AI call |
| `buildDocsIndexFromFiles(files)` | Build the "Ask" agent's grounding index from doc files |
| `answerHowTo(opts)` / `streamHowTo(opts)` | The read-only how-to (RAG) agent, whole-answer or streamed, with its sources; `buildGroundingContext`, `ASK_HOWTO_PROMPT_VERSION` |
| Types | `ModelSelection`, `ResolvedModelSelection`, `OrgModelSelection`, `OrgSelectionDeps`, `AICallOptions`, `AICallSettings`, `FailoverOptions`, `FailoverOutcome`, `AITokenUsage`, `AIUsageAuditDetails`, `GroundingIndex`, `DocFile`, `AskSource`, `AskStreamEvent` |
| Re-exported from the [`ai`](https://www.npmjs.com/package/ai) SDK | `generateText`, `streamText`, `Output`, `tool`, `generateObject`, `stepCountIs`; types `LanguageModel`, `LanguageModelUsage`, `SystemModelMessage`, `ToolSet` |

## Usage

```typescript
import { resolveModel, generateText } from '@pipeline-builder/ai-core';

const model = resolveModel('anthropic', 'claude-sonnet-5');
const { text } = await generateText({ model, prompt: 'Generate a pipeline spec…' });
```

## Development

```bash
pnpm build   # projen build (compile + lint + test + package)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
