// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module lib/ai-constants
 * @description Shared AI provider constants for frontend components.
 *
 * AIPluginBuilderTab and other AI surfaces use these for provider display
 * names and org-level model catalogs.
 * This is the frontend counterpart to the backend's `AI_PROVIDER_CATALOG`
 * in api-core.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-exported from api-core so the server and the client cannot drift: this
// was a second, identical declaration of a shape that crosses the wire.
import { AI_PROVIDER_MODELS, AI_PROVIDER_NAMES, type AIModelInfo } from '@pipeline-builder/api-core/ai-catalog';
export type { AIModelInfo };

/**
 * Provider info as seen by frontend components.
 * Includes a `source` field indicating whether the provider is configured
 * via server env vars, per-organization API keys, or not configured at all —
 * or, for the combined "Local model" entry, that it is the self-hosted model
 * (see {@link LOCAL_MODEL_NAME}).
 */
export interface AIProviderInfo {
  id: string;
  name: string;
  source: 'server' | 'org' | 'none' | 'local';
  models: AIModelInfo[];
  /**
   * Listed but unable to serve: set on the "Local model" entry when the Ask
   * agent is not answering and no local provider is configured to fall back on.
   * Never selected by default; the picker shows it disabled.
   */
  unavailable?: boolean;
}

/**
 * Display name of the single "Local model" entry the create dialogs lead with:
 * the deployment's self-hosted model, reached through whichever route can serve.
 * Its `id` names that route — {@link ASK_AGENT_PROVIDER_ID} when drafts go
 * through the Ask agent (doc-grounded), {@link OPENAI_COMPATIBLE_PROVIDER_ID}
 * when they go straight to the local provider — so the tabs pass `id`/model
 * through unchanged and branch only on {@link routesViaAskAgent}.
 */
export const LOCAL_MODEL_NAME = 'Local model';

/**
 * The "Local model" entry's id while it routes through the Ask agent: the draft
 * is produced by the Ask agent (the `ask-agent` service's tool-calling loop)
 * instead of calling the pipeline/plugin generator directly. Its models are the
 * ask-agent service's server-configured ones, each identified by a composite
 * `provider|model` id — see {@link askAgentModelId}.
 */
export const ASK_AGENT_PROVIDER_ID = 'ask-agent';

/**
 * The local / self-hosted (OpenAI-compatible) provider id — also the "Local
 * model" entry's id while it routes straight to that provider. Mirrors
 * `OPENAI_COMPATIBLE_PROVIDER_ID` in `@pipeline-builder/api-core`, which is not
 * exported on the browser-safe `ai-catalog` subpath.
 */
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

/** True when the selected provider routes generation through the Ask agent (`streamAgentDraft`). */
export function routesViaAskAgent(providerId: string): boolean {
  return providerId === ASK_AGENT_PROVIDER_ID;
}

/** Separator for composite Ask-agent model ids — never occurs in a provider id. */
const ASK_AGENT_MODEL_SEP = '|';

/** Build the composite model id for an Ask-agent model entry. */
export function askAgentModelId(provider: string, model: string): string {
  return `${provider}${ASK_AGENT_MODEL_SEP}${model}`;
}

/** Split a composite Ask-agent model id back into the real provider + model. */
export function splitAskAgentModel(id: string): { provider: string; model: string } {
  const i = id.indexOf(ASK_AGENT_MODEL_SEP);
  return i < 0 ? { provider: '', model: id } : { provider: id.slice(0, i), model: id.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Standard model lists for all known providers.
 *
 * When a provider is configured via organization settings (not server env vars),
 * the backend doesn't return a model list. This catalog provides the models
 * so the frontend can still offer model selection. Also used as the fallback
 * catalog when providers aren't configured (source: 'none').
 *
 * DERIVED from api-core's catalog (the browser-safe `ai-catalog` subpath), never
 * restated here: a second copy is how the picker came to offer model ids the
 * backend's registry no longer accepted.
 */
export const ORG_PROVIDER_MODELS: Record<string, AIModelInfo[]> = AI_PROVIDER_MODELS;

/**
 * Display names for AI provider IDs.
 * Used when constructing org-level or unconfigured provider entries.
 */
export { AI_PROVIDER_NAMES };

/**
 * Returns a display label for a provider's source/configuration status.
 */
export function getProviderSourceLabel(provider: AIProviderInfo): string {
  if (provider.source === 'none') return 'API key required';
  if (provider.unavailable) return 'unavailable';
  if (provider.source === 'local') return 'default';
  return provider.source;
}
