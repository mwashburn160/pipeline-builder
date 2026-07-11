import { createContext, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { useAuth } from './useAuth';
import { isSystemAdmin } from '@/lib/auth-helpers';
import api from '@/lib/api';

/** Shape of the features context value. */
interface FeaturesContextType {
  /** Check if a specific feature is enabled for the current user. */
  isEnabled: (feature: string) => boolean;
  /** All currently enabled features. */
  features: string[];
  /** Whether the initial config fetch has completed. */
  isLoaded: boolean;
}

const FeaturesContext = createContext<FeaturesContextType>({
  isEnabled: () => false,
  features: [],
  isLoaded: false,
});

/**
 * Provider that fetches service features from `/config` and merges them with
 * per-user feature flags from the authenticated user profile.
 *
 * Must be rendered inside {@link AuthProvider}.
 */
export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [serviceFeatures, setServiceFeatures] = useState<Record<string, boolean>>({});
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getConfig().then((res) => {
      if (!cancelled && res.success && res.data) {
        setServiceFeatures(res.data.serviceFeatures);
      }
    }).catch(() => {
      // Config fetch failed — default billing shown
      if (!cancelled) setServiceFeatures({ billing: true, email: false, oauth: false });
    }).finally(() => {
      if (!cancelled) setIsLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  const value = useMemo(() => {
    const enabled = new Set<string>();

    // Service-level features
    for (const [key, val] of Object.entries(serviceFeatures)) {
      if (val) enabled.add(key);
    }

    // Sysadmins don't need their own billing tab — they manage billing for
    // every org, not pay one themselves.
    if (isSystemAdmin(user)) {
      enabled.delete('billing');
    }

    // Per-user features from auth profile
    if (user?.features) {
      for (const f of user.features) {
        enabled.add(f);
      }
    }

    // Per-user overrides — explicit enable (true) / disable (false) that take
    // precedence over the service + tier defaults. Previously stored on the user
    // but never consumed, so a per-user DISABLE was silently ignored.
    if (user?.featureOverrides) {
      for (const [key, on] of Object.entries(user.featureOverrides)) {
        if (on) enabled.add(key); else enabled.delete(key);
      }
    }

    const features = [...enabled];
    return {
      isEnabled: (feature: string) => enabled.has(feature),
      features,
      isLoaded,
    };
  }, [serviceFeatures, user, isLoaded]);

  return (
    <FeaturesContext.Provider value={value}>
      {children}
    </FeaturesContext.Provider>
  );
}

/**
 * Returns the unified feature set for the current user.
 * Includes both service-level features (billing, email, oauth) and
 * per-user feature flags (ai_generation, bulk_operations, etc.).
 *
 * Must be used within a {@link FeaturesProvider}.
 */
export function useFeatures() {
  return useContext(FeaturesContext);
}
