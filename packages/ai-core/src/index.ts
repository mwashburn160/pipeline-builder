export {
  getAvailableProviders,
  getProviderModels,
  resolveModel,
  createModelWithKey,
} from './provider-registry';

export type { ProviderEntry } from './provider-registry';

// Re-export AI SDK types consumers commonly need
export type { LanguageModel } from 'ai';
export { generateText, streamText, Output } from 'ai';
