import { useState, useEffect } from 'react';
import {
  type AIProviderInfo,
  ORG_PROVIDER_MODELS,
  AI_PROVIDER_NAMES,
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
  /** Source of the currently selected provider ('server', 'org', or 'none'). */
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

/**
 * Fetch and merge server + org AI providers, manage selection state.
 *
 * Always shows all known providers in the dropdown. Configured providers
 * (server/org) are listed first, followed by unconfigured ones that require
 * a custom API key. When an unconfigured provider is selected, the API key
 * override section auto-expands.
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

        // Sort: configured providers first (Ollama first among those),
        // then unconfigured providers alphabetically
        merged.sort((a, b) => {
          const aConfigured = a.source !== 'none' ? 0 : 1;
          const bConfigured = b.source !== 'none' ? 0 : 1;
          if (aConfigured !== bConfigured) return aConfigured - bConfigured;
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
