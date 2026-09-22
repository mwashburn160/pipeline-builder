// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import {
  type AIProviderInfo,
  ASK_AGENT_PROVIDER_ID,
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
  /** Source of the currently selected provider ('server', 'org', 'none', or 'agent'). */
  currentSource: AIProviderInfo['source'] | undefined;
  /** Custom API key override value. */
  customApiKey: string;
  /** Update the custom API key. */
  setCustomApiKey: (key: string) => void;
  /** Whether the API key override section is expanded. */
  showKeyOverride: boolean;
  /** Toggle the API key override section. */
  setShowKeyOverride: (show: boolean) => void;
}

/** Options for {@link useAIProviders}. */
export interface UseAIProvidersOptions {
  /**
   * Offer "Ask agent" as the first — and therefore default — provider: drafts
   * are routed through the Ask agent (see `streamAgentDraft`). Its models are
   * the ask service's server-configured ones. Omitted when the ask service
   * reports no configured provider or is unreachable, so the picker falls back
   * to the direct providers.
   */
  askAgent?: boolean;
}

type ProvidersResponse = { data?: { providers?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> } };

/** Build the synthetic "Ask agent" entry from the ask service's providers. */
function askAgentEntry(res: ProvidersResponse): AIProviderInfo | null {
  const models = (res.data?.providers ?? []).flatMap((p) =>
    p.models.map((m) => ({ id: askAgentModelId(p.id, m.id), name: `${m.name} (${p.name})` })));
  return models.length > 0 ? { id: ASK_AGENT_PROVIDER_ID, name: 'Ask agent', source: 'agent', models } : null;
}

type OrgAIConfigResponse = Awaited<ReturnType<typeof api.getOrgAIConfig>>;

/**
 * Merge the provider sources into the picker's list: server-configured first
 * (they win over an org key for the same id), then org-configured, then every
 * other known provider as unconfigured (needs a custom key) — configured ones
 * first, then alphabetical. "Ask agent" (when offered) leads the list and so
 * becomes the default selection. Each source is `null` when it wasn't asked for
 * or its request failed.
 */
export function mergeAIProviders(
  server: ProvidersResponse | null,
  org: OrgAIConfigResponse | null,
  ask: ProvidersResponse | null,
): AIProviderInfo[] {
  const serverProviders: AIProviderInfo[] = (server?.data?.providers ?? []).map((p) => ({ ...p, source: 'server' as const }));

  const orgProviders: AIProviderInfo[] = [];
  for (const [id, status] of Object.entries(org?.data?.providers ?? {})) {
    if (status.configured) {
      orgProviders.push({ id, name: AI_PROVIDER_NAMES[id] ?? id, source: 'org', models: ORG_PROVIDER_MODELS[id] ?? [] });
    }
  }

  const serverIds = new Set(serverProviders.map((p) => p.id));
  const merged = [...serverProviders, ...orgProviders.filter((p) => !serverIds.has(p.id))];

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

  const agent = ask ? askAgentEntry(ask) : null;
  if (agent) merged.unshift(agent);
  return merged;
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
    const [server, org, ask] = await Promise.allSettled([
      fetchServerProviders(),
      api.getOrgAIConfig(),
      options.askAgent ? api.getAskProviders() : Promise.resolve(null),
    ]);
    const value = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
    return {
      providers: mergeAIProviders(value(server), value(org), value(ask)),
      degraded: [server, org, ask].some((r) => r.status === 'rejected'),
    };
  }, [], {
    // Default selection: the first provider and its first model.
    onSuccess: ({ providers: merged }) => {
      const first = merged[0];
      if (!first) return;
      setSelectedProviderState(first.id);
      if (first.models.length > 0) setSelectedModel(first.models[0].id);
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
  };

  const currentModels = providers.find((p) => p.id === selectedProvider)?.models ?? [];
  const currentSource = providers.find((p) => p.id === selectedProvider)?.source;

  return {
    providers,
    loading,
    error,
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
