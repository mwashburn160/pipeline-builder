// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from 'react';
import {
  type AIProviderInfo,
  ASK_AGENT_PROVIDER_ID,
  ORG_PROVIDER_MODELS,
  AI_PROVIDER_NAMES,
  askAgentModelId,
} from '@/lib/ai-constants';
import api from '@/lib/api';

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

/**
 * Fetch and merge server + org AI providers, manage selection state.
 *
 * Always shows all known providers in the dropdown. Configured providers
 * (server/org) are listed first, followed by unconfigured ones that require
 * a custom API key. When an unconfigured provider is selected, the API key
 * override section auto-expands. With `askAgent`, the "Ask agent" entry leads
 * the list and is selected by default.
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
  const [providers, setProviders] = useState<AIProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProviderState] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [showKeyOverride, setShowKeyOverride] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [serverResponse, orgResponse, askResponse] = await Promise.allSettled([
          fetchServerProviders(),
          api.getOrgAIConfig(),
          options.askAgent ? api.getAskProviders() : Promise.resolve(null),
        ]);

        if (cancelled) return;

        // Server providers (from env vars)
        const serverProviders: AIProviderInfo[] =
          serverResponse.status === 'fulfilled'
            ? (serverResponse.value.data?.providers ?? []).map((p) => ({
                ...p,
                source: 'server' as const,
              }))
            : [];

        // Org providers (from saved keys)
        const orgProviders: AIProviderInfo[] = [];
        if (orgResponse.status === 'fulfilled' && orgResponse.value.data?.providers) {
          const orgConfig = orgResponse.value.data.providers;
          for (const [id, status] of Object.entries(orgConfig)) {
            if (status.configured) {
              orgProviders.push({
                id,
                name: AI_PROVIDER_NAMES[id] ?? id,
                source: 'org',
                models: ORG_PROVIDER_MODELS[id] ?? [],
              });
            }
          }
        }

        // Merge: server providers take priority, add org-only providers
        const serverIds = new Set(serverProviders.map((p) => p.id));
        const merged = [
          ...serverProviders,
          ...orgProviders.filter((p) => !serverIds.has(p.id)),
        ];

        // Add unconfigured providers from the full catalog
        const configuredIds = new Set(merged.map((p) => p.id));
        for (const [id, name] of Object.entries(AI_PROVIDER_NAMES)) {
          if (!configuredIds.has(id)) {
            merged.push({
              id,
              name,
              source: 'none',
              models: ORG_PROVIDER_MODELS[id] ?? [],
            });
          }
        }

        // Sort: configured providers first, then unconfigured alphabetically
        merged.sort((a, b) => {
          const aConfigured = a.source !== 'none' ? 0 : 1;
          const bConfigured = b.source !== 'none' ? 0 : 1;
          if (aConfigured !== bConfigured) return aConfigured - bConfigured;
          return a.name.localeCompare(b.name);
        });

        // "Ask agent" leads the list (and so becomes the default selection).
        const agent = askResponse.status === 'fulfilled' && askResponse.value ? askAgentEntry(askResponse.value) : null;
        if (agent) merged.unshift(agent);

        // Surface a genuine fetch failure. `Promise.allSettled` never rejects,
        // so the `catch` below could only fire on a synchronous throw in the
        // merge code — which meant a 500 from the providers endpoint rendered
        // as the plausible-looking "no providers configured, enter your own API
        // key" empty state, and `error` was permanently unreachable.
        //
        // Deliberately NOT fatal: the catalog below still lists every provider,
        // so a user with their own key can proceed. The banner just stops the
        // outage from masquerading as a configuration state.
        const rejected = [serverResponse, orgResponse, askResponse].filter((r) => r.status === 'rejected');
        if (rejected.length > 0) {
          setError('Could not load configured AI providers — showing the full catalog. Your saved keys may be unavailable.');
        }

        setProviders(merged);
        if (merged.length > 0) {
          setSelectedProviderState(merged[0].id);
          if (merged[0].models.length > 0) {
            setSelectedModel(merged[0].models[0].id);
          }
          // Auto-expand API key field if first provider is unconfigured
          if (merged[0].source === 'none') {
            setShowKeyOverride(true);
          }
        }
      } catch {
        if (!cancelled) setError('Failed to load AI providers');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time fetch on mount; no deps needed
  }, []);

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
