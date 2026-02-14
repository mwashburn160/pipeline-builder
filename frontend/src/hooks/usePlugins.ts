import { useState, useEffect, useCallback, useRef } from 'react';
import { Plugin } from '@/types';
import api from '@/lib/api';

// Module-level cache shared across all hook instances
let cachedPlugins: Plugin[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearPluginCache() {
  cachedPlugins = null;
  cacheTimestamp = 0;
}

export interface PluginGroup {
  category: string;
  plugins: Plugin[];
}

export function usePlugins(enabled = true) {
  const [plugins, setPlugins] = useState<Plugin[]>(cachedPlugins || []);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchPlugins = useCallback(async () => {
    if (cachedPlugins && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
      setPlugins(cachedPlugins);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await api.listPlugins({ limit: '500', isActive: 'true' });
      const fetched = (response.plugins || []) as Plugin[];
      cachedPlugins = fetched;
      cacheTimestamp = Date.now();
      setPlugins(fetched);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load plugins');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && !fetchedRef.current) {
      fetchedRef.current = true;
      fetchPlugins();
    }
  }, [enabled, fetchPlugins]);

  return { plugins, isLoading, error, refetch: fetchPlugins };
}

export function groupPlugins(plugins: Plugin[], filter: string): PluginGroup[] {
  const query = filter.toLowerCase();

  const filtered = query
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          (p.description || '').toLowerCase().includes(query) ||
          p.version.toLowerCase().includes(query),
      )
    : plugins;

  const orgPlugins = filtered.filter((p) => p.accessModifier === 'private');
  const publicPlugins = filtered.filter((p) => p.accessModifier === 'public');

  const groups: PluginGroup[] = [];
  if (orgPlugins.length > 0) groups.push({ category: 'Organization', plugins: orgPlugins });
  if (publicPlugins.length > 0) groups.push({ category: 'Public', plugins: publicPlugins });
  return groups;
}
