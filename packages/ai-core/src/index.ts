// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  getAvailableProviders,
  getProviderModels,
  resolveModel,
  createModelWithKey,
} from './provider-registry.js';

export type { ProviderEntry } from './provider-registry.js';

// Grounding / retrieval for the "Ask" agent
export {
  tokenize,
  chunkMarkdown,
  buildGroundingIndex,
  buildDocsIndexFromFiles,
} from './grounding.js';
export type { GroundingDoc, GroundingHit, GroundingIndex, DocFile } from './grounding.js';

// "Ask" agent — read-only how-to (RAG) core
export {
  answerHowTo,
  streamHowTo,
  buildGroundingContext,
} from './ask-agent.js';
export type { AskSource, AnswerHowToOptions } from './ask-agent.js';

// Re-export AI SDK types consumers commonly need
export type { LanguageModel, Tool, ToolSet } from 'ai';
// generateText/streamText/Output for generation; tool/generateObject/stepCountIs
// for the agent tool-calling loop (Phase 2 write tools).
export { generateText, streamText, Output, tool, generateObject, stepCountIs } from 'ai';
