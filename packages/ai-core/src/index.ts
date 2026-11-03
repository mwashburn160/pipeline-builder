// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  getAvailableProviders,
  getProviderModels,
  resolveModel,
  resolveModelSelection,
} from './provider-registry.js';
export type { ModelSelection, ResolvedModelSelection, KeySource } from './provider-registry.js';

// Org-aware selection: request BYO key > the org's own provider key > platform key,
// honouring the org's AI switch, never silently downgrading to the platform key.
export { resolveOrgModelSelection } from './org-selection.js';
export type { OrgModelSelection, OrgSelectionDeps } from './org-selection.js';

// Per-call policy every AI entry point shares (timeout/abort, output cap, retries,
// temperature, prompt caching, untrusted-data fencing, platform failover, audit).
export {
  AI_REQUEST_TIMEOUT_MS,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_RETRIES,
  aiCallSignal,
  capOutputTokens,
  samplingTemperature,
  aiCallSettings,
  cachedSystemPrompt,
  asPromptData,
  asPromptDataBlock,
  isRetryableAIError,
  platformFailoverChain,
  runWithFailover,
  tokenUsage,
  aiUsageAuditDetails,
} from './ai-call.js';
export type {
  AICallOptions,
  AICallSettings,
  FailoverOptions,
  FailoverOutcome,
  AITokenUsage,
  AIUsageAuditDetails,
} from './ai-call.js';

// Grounding / retrieval for the "Ask" agent. `tokenize`, `chunkMarkdown` and
// `buildGroundingIndex` are the index-building internals `buildDocsIndexFromFiles`
// composes — consumers hand it doc files and get an index back.
export { buildDocsIndexFromFiles } from './grounding.js';
export type { GroundingIndex, DocFile } from './grounding.js';

// "Ask" agent — read-only how-to (RAG) core
export {
  answerHowTo,
  streamHowTo,
  buildGroundingContext,
  ASK_HOWTO_PROMPT_VERSION,
} from './ask-agent.js';
export type { AskSource, AskStreamEvent } from './ask-agent.js';

// Re-export AI SDK types consumers commonly need
export type { LanguageModel, LanguageModelUsage, SystemModelMessage, ToolSet } from 'ai';
// generateText/streamText/Output for generation; tool/generateObject/stepCountIs
// for the agent tool-calling loop (write tools).
export { generateText, streamText, Output, tool, generateObject, stepCountIs } from 'ai';
