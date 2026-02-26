/**
 * Application configuration context and provider.
 * Fetches feature flags (billing, email, OAuth) from the server on mount
 * and exposes them via React context so any component can check enabled features.
 */
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import api from '@/lib/api';

/** Feature flags fetched from the server's /config endpoint. */
interface AppConfig {
  billingEnabled: boolean;
  emailEnabled: boolean;
  oauthEnabled: boolean;
}

/** Shape of the config context value. */
interface ConfigContextType {
  config: AppConfig;
  /** Whether the initial config fetch has completed (regardless of success/failure). */
  isLoaded: boolean;
}

/** Default config used before the server responds (or on fetch failure). */
const DEFAULT_CONFIG: AppConfig = {
  billingEnabled: true,
  emailEnabled: false,
  oauthEnabled: false,
};

const ConfigContext = createContext<ConfigContextType>({
  config: DEFAULT_CONFIG,
  isLoaded: false,
});

/**
 * Context provider that fetches application config on mount.
 * Wrap the app tree with this to make feature flags available via {@link useConfig}.
 */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.getConfig();
        if (!cancelled && res.success && res.data) {
          setConfig({
            billingEnabled: res.data.billingEnabled,
            emailEnabled: res.data.emailEnabled,
            oauthEnabled: res.data.oauthEnabled,
          });
        }
      } catch {
        // Config fetch failed — use defaults (billing shown)
      } finally {
        if (!cancelled) setIsLoaded(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <ConfigContext.Provider value={{ config, isLoaded }}>
      {children}
    </ConfigContext.Provider>
  );
}

/**
 * Reads the application config from context.
 * Must be used within a {@link ConfigProvider}.
 *
 * @returns The current config and whether it has finished loading
 */
export function useConfig() {
  return useContext(ConfigContext);
}
