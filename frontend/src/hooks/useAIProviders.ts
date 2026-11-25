// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { isKeylessProviderId } from '@pipeline-builder/api-core/ai-catalog';
import {
  type AIProviderInfo,
  ASK_AGENT_PROVIDER_ID,
  LOCAL_MODEL_NAME,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ORG_PROVIDER_MODELS,
  AI_PROVIDER_NAMES,
  askAgentModelId,
} from '@/lib/ai-constants';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';

const NO_PROVIDERS: AIProviderInfo[] = [];

/** Return type of the {@link useAIProviders} hook. */
export interface UseAIProvidersResult {
  /** Merged list of available providers (server + org + unconfigured). */
  providers: AIProviderInfo[];
  /** Whether providers are still being fetched. */
  loading: boolean;
  /** Error message if provider fetch failed, or null. */
  error: string | null;
  /** Currently selected provider ID. */
  selectedProvider: string;
  /** Currently selected model ID. */
  selectedModel: string;
  /** Update the selected provider (also resets model to first available). */
  setSelectedProvider: (id: string) => void;
  /** Update the selected model. */
  setSelectedModel: (id: string) => void;
  /** Models available for the currently selected provider. */
  currentModels: AIProviderInfo['models'];
  /** Source of the currently selected provider ('server', 'org', 'none', or 'local'). */
  currentSource: AIProviderInfo['source'] | undefined;
  /** Custom API key override value. */
  customApiKey: string;
  /** Update the custom API key. */
  setCustomApiKey: (key: string) => void;
  /** Whether the API key override section is expanded. */
  showKeyOverride: boolean;
  /** Toggle the API key override section. */
  setShowKeyOverride: (show: boolean) => void;
  /**
   * Whether ANY provider is actually configured on this deployment (server env
   * or an org-saved key), as opposed to merely being listed in the catalog.
   *
   * The catalog always lists every provider so that a user with their own key
   * can pick one, which means "the list is non-empty" says nothing about
   * whether a request can succeed. Callers use this to say so BEFORE a turn is
   * sent, instead of letting the backend answer with a vendor-specific error.
   */
  hasConfiguredProvider: boolean;
  /**
   * Set when the "Local model" entry can serve on NEITHER route — the Ask agent
   * failed its availability check and no local provider is configured to go to
   * directly: a sentence for the user saying so. The entry is then listed as
   * unavailable and the default moved to the next configured provider. Null
   * otherwise (including when the direct route quietly took over).
   */
  localModelUnavailable: string | null;
  /**
   * True when the organization's administrators switched AI features off
   * (`aiEnabled: false` on the org AI config). Every AI entry point then refuses
   * with `AI_DISABLED`, so callers show a locked state instead of a picker and
   * a button that can only fail.
   */
  aiDisabled: boolean;
}

/** Options for {@link useAIProviders}. */
export interface UseAIProvidersOptions {
  /**
   * Lead with the single "Local model" entry — the self-hosted model — as the
   * default provider (see {@link mergeAIProviders}). When the ask-agent service
   * offers a self-hosted (openai-compatible) model, it is checked live
   * (`GET /ask-agent/availability?probe=true`): answering, the entry routes
   * drafts through the Ask agent (`streamAgentDraft`, doc-grounded); not
   * answering, straight to the local OpenAI-compatible provider when one is
   * configured. The separate "Ask agent" / local-provider entries never appear.
   */
  askAgent?: boolean;
}

type ProvidersResponse = { data?: { providers?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> } };

/**
 * The Ask agent's SELF-HOSTED models, as composite `provider|model` ids (see
 * `askAgentModelId`). Only the openai-compatible provider counts: "Local model"
 * must only ever mean the self-hosted model, so an agent configured with a
 * cloud provider (Bedrock, Anthropic, …) contributes nothing here.
 */
function askAgentLocalModels(res: ProvidersResponse | null): AIProviderInfo['models'] {
  return (res?.data?.providers ?? [])
    .filter((p) => p.id === OPENAI_COMPATIBLE_PROVIDER_ID)
    .flatMap((p) => p.models.map((m) => ({ id: askAgentModelId(p.id, m.id), name: m.name })));
}

/** What {@link mergeAIProviders} needs to build the "Local model" entry. */
export interface LocalModelSources {
  /** The ask-agent service's providers, or null when not offered / unreachable. */
  agent: ProvidersResponse | null;
  /** Whether the Ask agent's self-hosted model passed its live availability check. */
  agentAnswering: boolean;
}

/**
 * The single "Local model" entry, or null when there is nothing self-hosted to
 * offer. Routes via the Ask agent when the agent serves the self-hosted model
 * and is answering; otherwise straight to the local provider (`local`, already
 * merged) when configured; otherwise — the agent serves the self-hosted model
 * but cannot answer, and there is no direct route — it is listed as
 * unavailable on the agent route. An agent on a cloud provider never counts.
 */
function localModelEntry(sources: LocalModelSources, local: AIProviderInfo | undefined): AIProviderInfo | null {
  const agentModels = askAgentLocalModels(sources.agent);
  const base = { name: LOCAL_MODEL_NAME, source: 'local' as const };
  if (agentModels.length > 0 && sources.agentAnswering) return { ...base, id: ASK_AGENT_PROVIDER_ID, models: agentModels };
  if (local && local.source !== 'none' && local.models.length > 0) return { ...base, id: OPENAI_COMPATIBLE_PROVIDER_ID, models: local.models };
  if (agentModels.length > 0) return { ...base, id: ASK_AGENT_PROVIDER_ID, models: agentModels, unavailable: true };
  return null;
}

type OrgAIConfigResponse = Awaited<ReturnType<typeof api.getOrgAIConfig>>;

/**
 * Merge the provider sources into the picker's list: org-configured first, then
 * server-configured, then every other known provider as unconfigured (needs a
 * custom key) — configured ones first, then alphabetical. Each source is
 * `null` when it wasn't asked for or its request failed.
 *
 * With `localModel` (the create dialogs), the Ask agent and the local
 * OpenAI-compatible provider are folded into ONE "Local model" entry that leads
 * the list and so becomes the default selection — see {@link localModelEntry}
 * for which route it takes. Without it (the Ask panel) the list is left as is.
 *
 * The ORG key wins over the platform's for the same provider id, because that is
 * what the backend does (precedence: the caller's own key > the org's key > the
 * platform's) — so a provider both have is labelled `org`, the key that will
 * actually be billed.
 */
export function mergeAIProviders(
  server: ProvidersResponse | null,
  org: OrgAIConfigResponse | null,
  localModel?: LocalModelSources,
): AIProviderInfo[] {
  const serverProviders: AIProviderInfo[] = (server?.data?.providers ?? []).map((p) => ({ ...p, source: 'server' as const }));

  const orgProviders: AIProviderInfo[] = [];
  for (const [id, status] of Object.entries(org?.data?.providers ?? {})) {
    // `configured` arrives over the wire; a keyless provider is never served on
    // an org key, so it must not be labelled `org` whatever the payload says.
    if (status.configured && !isKeylessProviderId(id)) {
      const catalogModels = ORG_PROVIDER_MODELS[id] ?? [];
      const serverModels = serverProviders.find((p) => p.id === id)?.models ?? [];
      orgProviders.push({ id, name: AI_PROVIDER_NAMES[id] ?? id, source: 'org', models: catalogModels.length > 0 ? catalogModels : serverModels });
    }
  }

  const orgIds = new Set(orgProviders.map((p) => p.id));
  const merged = [...orgProviders, ...serverProviders.filter((p) => !orgIds.has(p.id))];

  const configuredIds = new Set(merged.map((p) => p.id));
  for (const [id, name] of Object.entries(AI_PROVIDER_NAMES)) {
    if (!configuredIds.has(id)) merged.push({ id, name, source: 'none', models: ORG_PROVIDER_MODELS[id] ?? [] });
  }

  merged.sort((a, b) => {
    const aConfigured = a.source !== 'none' ? 0 : 1;
    const bConfigured = b.source !== 'none' ? 0 : 1;
    if (aConfigured !== bConfigured) return aConfigured - bConfigured;
    return a.name.localeCompare(b.name);
  });

  if (!localModel) return merged;
  const entry = localModelEntry(localModel, merged.find((p) => p.id === OPENAI_COMPATIBLE_PROVIDER_ID));
  const rest = merged.filter((p) => p.id !== OPENAI_COMPATIBLE_PROVIDER_ID);
  return entry ? [entry, ...rest] : rest;
}

/**
 * Fetch and merge server + org AI providers, manage selection state.
 *
 * Always shows all known providers in the dropdown (see {@link mergeAIProviders}).
 * When an unconfigured provider is selected, the API key override section
 * auto-expands.
 *
 * @param fetchServerProviders - Function to fetch server-configured providers
 *   (different endpoint per service: pipeline vs plugin)
 * @param options - See {@link UseAIProvidersOptions}
 * @returns Provider state and selection handlers
 */
/**
 * The provider to select by default: the first that can actually serve a
 * request, falling back to the first listed when none can.
 *
 * This used to be `merged[0]` outright. `mergeAIProviders` sorts configured
 * providers first and then ALPHABETICALLY, so on a deployment with nothing
 * configured `merged[0]` is whichever unconfigured provider happens to sort
 * first — "Amazon Bedrock", ahead of Anthropic, Google, OpenAI and xAI. The Ask
 * panel then sent `provider: amazon-bedrock` and the user got
 * `AI provider "amazon-bedrock" is not configured`: a message about one vendor,
 * for a deployment-wide problem, naming a vendor they never chose.
 *
 * A provider needs a model as well as a source to be selectable, so both are
 * required rather than assuming the catalog filled models in.
 *
 * Exported for the test that pins this: the fallback makes the wrong behaviour
 * invisible in the UI, because something is always selected either way.
 */
export function pickDefaultProvider(merged: AIProviderInfo[]): AIProviderInfo | undefined {
  return merged.find((p) => p.source !== 'none' && !p.unavailable && p.models.length > 0)
    ?? merged.find((p) => !p.unavailable);
}

/** Shown when the availability check itself could not be completed and nothing else can serve the local model. */
const LOCAL_MODEL_CHECK_FAILED = 'Could not confirm the local model is available, so another provider was selected.';

export function useAIProviders(
  fetchServerProviders: () => Promise<ProvidersResponse>,
  options: UseAIProvidersOptions = {},
): UseAIProvidersResult {
  const [selectedProvider, setSelectedProviderState] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [showKeyOverride, setShowKeyOverride] = useState(false);

  // One read on mount. A failed source is NOT fatal: the catalog still lists
  // every provider, so a user with their own key can proceed — the error only
  // stops an outage from masquerading as "no providers configured".
  const { data, loading, error: loadError } = useFetch(async () => {
    const askProviders = options.askAgent ? api.getAskProviders() : Promise.resolve(null);
    // The availability check is of the agent's SELF-HOSTED model — the only one
    // "Local model" may route to (see askAgentLocalModels) — so it chains on the
    // provider list while the other two sources load in parallel. An agent with
    // no self-hosted model is never checked.
    const askCheck = askProviders.then((res) => (askAgentLocalModels(res).length > 0
      ? api.getAskAvailability({ probe: true, provider: OPENAI_COMPATIBLE_PROVIDER_ID })
      : null));
    const [server, org, ask, check] = await Promise.allSettled([
      fetchServerProviders(),
      api.getOrgAIConfig(),
      askProviders,
      askCheck,
    ]);
    const value = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
    // A check that could not complete counts as "not answering": the point is
    // not to route through an agent that may only fail.
    const availability = value(check)?.data;
    const providers = mergeAIProviders(value(server), value(org), options.askAgent
      ? { agent: value(ask), agentAnswering: availability?.available === true }
      : undefined);

    // Said only when NEITHER route can serve — the direct route taking over is
    // not worth a warning.
    const localModelUnavailable = providers.some((p) => p.source === 'local' && p.unavailable)
      ? (availability?.available === false ? `${availability.message} Another provider was selected instead.` : LOCAL_MODEL_CHECK_FAILED)
      : null;
    return {
      providers,
      localModelUnavailable,
      degraded: [server, org, ask].some((r) => r.status === 'rejected'),
      // Explicitly `false` only: an unreadable org config must not lock the UI —
      // the server still refuses a disabled org, and says why.
      aiDisabled: value(org)?.data?.aiEnabled === false,
    };
  }, [], {
    onSuccess: ({ providers: merged }) => {
      const first = pickDefaultProvider(merged);
      if (!first) return;
      setSelectedProviderState(first.id);
      if (first.models.length > 0) setSelectedModel(first.models[0].id);
      // Nothing configured: the only route to an answer is the user's own key,
      // so open that field rather than leaving them to find it.
      if (first.source === 'none') setShowKeyOverride(true);
    },
  });
  const providers = data?.providers ?? NO_PROVIDERS;
  const error = loadError
    ? 'Failed to load AI providers'
    : data?.degraded
      ? 'Could not load configured AI providers — showing the full catalog. Your saved keys may be unavailable.'
      : null;
  /** Update provider selection and reset model to first available. */
  const setSelectedProvider = (providerId: string) => {
    setSelectedProviderState(providerId);
    const provider = providers.find((p) => p.id === providerId);
    if (provider && provider.models.length > 0) {
      setSelectedModel(provider.models[0].id);
    } else {
      setSelectedModel('');
    }
    // Auto-expand API key field for unconfigured providers
    if (provider?.source === 'none') {
      setShowKeyOverride(true);
    }
    // Neither Local model route takes a per-request key: drop one typed for
    // another provider so the direct route never forwards it.
    if (provider?.source === 'local') {
      setCustomApiKey('');
      setShowKeyOverride(false);
    }
  };

  const currentModels = providers.find((p) => p.id === selectedProvider)?.models ?? [];
  const currentSource = providers.find((p) => p.id === selectedProvider)?.source;

  // `source` is the only honest signal: the catalog pads the list with every
  // known provider at `source: 'none'`, so length proves nothing.
  const hasConfiguredProvider = providers.some((p) => p.source !== 'none' && !p.unavailable && p.models.length > 0);

  return {
    providers,
    loading,
    error,
    hasConfiguredProvider,
    aiDisabled: data?.aiDisabled ?? false,
    localModelUnavailable: data?.localModelUnavailable ?? null,
    selectedProvider,
    selectedModel,
    setSelectedProvider,
    setSelectedModel,
    currentModels,
    currentSource,
    customApiKey,
    setCustomApiKey,
    showKeyOverride,
    setShowKeyOverride,
  };
}
