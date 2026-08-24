import { createContext, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { useAuth } from './useAuth';
import { isSystemAdmin } from '@/lib/auth-helpers';
import api from '@/lib/api';
import { DEFAULT_SUPPORT_ALIAS } from '@/lib/constants';

/** Shape of the features context value. */
interface FeaturesContextType {
  /** Check if a specific feature is enabled for the current user. */
  isEnabled: (feature: string) => boolean;
  /** All currently enabled features. */
  features: string[];
  /** Whether the initial config fetch has completed. */
  isLoaded: boolean;
  /** Primary support alias (from the server's SUPPORT_ALIASES) for compose prefill. */
  supportAlias: string;
  /** ALL configured support aliases, for listing every support inbox in the picker. */
  supportAliases: string[];
  /** Deployment target from `/config` (`aws-ec2` | `aws-eks` | `local` | `docker`
   *  | `minikube`) — lets UI gate target-specific content (e.g. the AWS-only
   *  onboarding CLI-setup section). Runtime value; defaults to `local`. */
  deployTarget: string;
}


const FeaturesContext = createContext<FeaturesContextType>({
  isEnabled: () => false,
  features: [],
  isLoaded: false,
  supportAlias: DEFAULT_SUPPORT_ALIAS,
  supportAliases: [DEFAULT_SUPPORT_ALIAS],
  deployTarget: 'local',
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
  const [supportAlias, setSupportAlias] = useState(DEFAULT_SUPPORT_ALIAS);
  const [supportAliases, setSupportAliases] = useState<string[]>([DEFAULT_SUPPORT_ALIAS]);
  const [deployTarget, setDeployTarget] = useState('local');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // Retry with capped backoff instead of freezing a fallback — a transient
    // /config failure (e.g. a boot-window 502) would otherwise leave `deployTarget`
    // at 'local' and permanently hide the AWS onboarding CLI-setup section.
    const run = () => {
      api.getConfig().then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setServiceFeatures(res.data.serviceFeatures);
          if (res.data.supportAlias) setSupportAlias(res.data.supportAlias);
          if (res.data.supportAliases?.length) setSupportAliases(res.data.supportAliases);
          if (res.data.deployTarget) setDeployTarget(res.data.deployTarget);
          setIsLoaded(true);
        } else {
          // 200 but `success:false` (no data): still release the loading gate so
          // the page doesn't hang on it forever (the old `.finally` covered this).
          setIsLoaded(true);
        }
      }).catch(() => {
        if (cancelled) return;
        // Show a safe default meanwhile, but keep retrying (1s, 2s, 4s … max 30s).
        setServiceFeatures((prev) => (Object.keys(prev).length ? prev : { billing: true, email: false, oauth: false }));
        setIsLoaded(true);
        const delay = Math.min(30_000, 1_000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(run, delay);
      });
    };
    run();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
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
      supportAlias,
      supportAliases,
      deployTarget,
    };
  }, [serviceFeatures, user, isLoaded, supportAlias, supportAliases, deployTarget]);

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
