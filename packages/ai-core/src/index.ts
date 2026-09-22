// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  getAvailableProviders,
  getProviderModels,
  resolveModel,
  createModelWithKey,
  resolveModelSelection,
} from './provider-registry.js';
export type { ModelSelection, ResolvedModelSelection } from './provider-registry.js';

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
} from './ask-agent.js';
export type { AskSource } from './ask-agent.js';

// Re-export AI SDK types consumers commonly need
export type { LanguageModel, ToolSet } from 'ai';
// generateText/streamText/Output for generation; tool/generateObject/stepCountIs
// for the agent tool-calling loop (write tools).
export { generateText, streamText, Output, tool, generateObject, stepCountIs } from 'ai';
