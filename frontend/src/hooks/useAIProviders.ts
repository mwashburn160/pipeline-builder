/**
 * @module hooks/useAIProviders
 * @description Shared hook for fetching, merging, and selecting AI providers.
 *
 * Both the pipeline AI builder and plugin AI builder need to:
 * 1. Fetch server-configured providers (env var keys)
 * 2. Fetch org-configured providers (saved API keys)
 * 3. Merge them with server taking priority
 * 4. Manage provider/model selection state
 *
 * This hook encapsulates that logic so both components stay DRY.
 *
 * @example
 * ```tsx
 * const ai = useAIProviders(() => api.getAIProviders());
 *
 * if (ai.loading) return <LoadingSpinner />;
 * // ai.providers, ai.selectedProvider, ai.selectedModel, etc.
 * ```
 */

import { useState, useEffect } from 'react';
import {
  type AIProviderInfo,
  ORG_PROVIDER_MODELS,
  AI_PROVIDER_NAMES,
} from '@/lib/ai-constants';
import api from '@/lib/api';

/** Return type of the {@link useAIProviders} hook. */
export interface UseAIProvidersResult {
  /** Merged list of available providers (server + org). */
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
  /** Source of the currently selected provider ('server' or 'org'). */
  currentSource: 'server' | 'org' | undefined;
  /** Custom API key override value. */
  customApiKey: string;
  /** Update the custom API key. */
  setCustomApiKey: (key: string) => void;
  /** Whether the API key override section is expanded. */
  showKeyOverride: boolean;
  /** Toggle the API key override section. */
  setShowKeyOverride: (show: boolean) => void;
}

/**
 * Fetch and merge server + org AI providers, manage selection state.
 *
 * @param fetchServerProviders - Function to fetch server-configured providers
 *   (different endpoint per service: pipeline vs plugin)
 * @returns Provider state and selection handlers
 */
export function useAIProviders(
  fetchServerProviders: () => Promise<{ data?: { providers?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> } }>,
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
        const [serverResponse, orgResponse] = await Promise.allSettled([
          fetchServerProviders(),
          api.getOrgAIConfig(),
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

        // Sort: Ollama first (local, no API key needed), then alphabetical
        merged.sort((a, b) => {
          if (a.id === 'ollama') return -1;
          if (b.id === 'ollama') return 1;
          return a.name.localeCompare(b.name);
        });

        setProviders(merged);
        if (merged.length > 0) {
          setSelectedProviderState(merged[0].id);
          if (merged[0].models.length > 0) {
            setSelectedModel(merged[0].models[0].id);
          }
        }
      } catch {
        if (!cancelled) setError('Failed to load AI providers');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
