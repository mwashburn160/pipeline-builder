import { createContext, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { useAuth } from './useAuth';
import { useBillingEnabled } from './useBillingEnabled';
import { hasPermission, isSystemAdmin } from '@/lib/auth-helpers';
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
  /** The viewer is a Pipeline Builder operator, who holds every entitlement.
   *  Surfaced here (rather than each consumer re-deriving it from `useAuth`)
   *  so an entitlement verdict is one hook call — see `useFeatureGate`. */
  isSuperAdmin: boolean;
  /** The viewer can actually OPEN `/dashboard/billing` — they hold `billing:read`
   *  AND the billing service runs in this deployment. Surfaced next to the
   *  entitlement verdict for the same reason `isSuperAdmin` is: a lock has to
   *  decide between the billing deep link and "ask an owner" in one hook call,
   *  and a lock that links a developer to a page they can't read replaces the
   *  upsell with a full-screen AccessDenied. See `useFeatureGate`. */
  canReachBilling: boolean;
  /** Primary support alias (from the server's SUPPORT_ALIASES) for compose prefill. */
  supportAlias: string;
  /** ALL configured support aliases, for listing every support inbox in the picker. */
  supportAliases: string[];
  /** Deployment target from `/config` (`aws-ec2` | `aws-eks` | `local` | `docker`
   *  | `minikube`) — lets UI gate target-specific content (e.g. the AWS-only
   *  onboarding CLI-setup section). Runtime value; defaults to `local`. */
  deployTarget: string;
  /** Effective per-tier quota limits from `/config` (reflecting `QUOTA_TIER_*`
   *  env overrides), or undefined until/unless the server reports them. */
  tierPresets: ServerTierPresets | undefined;
}

type ServerTierPresets = Record<string, { plugins: number; pipelines: number; apiCalls: number; aiCalls: number }>;


const FeaturesContext = createContext<FeaturesContextType>({
  isEnabled: () => false,
  features: [],
  isLoaded: false,
  isSuperAdmin: false,
  canReachBilling: false,
  supportAlias: DEFAULT_SUPPORT_ALIAS,
  supportAliases: [DEFAULT_SUPPORT_ALIAS],
  deployTarget: 'local',
  tierPresets: undefined,
});

/**
 * Provider that fetches service features from `/config` and merges them with
 * per-user feature flags from the authenticated user profile.
 *
 * Must be rendered inside {@link AuthProvider}.
 */
export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // Deployment-level billing switch, from the same memoised `/api/billing/config`
  // probe the sidebar uses — so "can this viewer act on an upsell?" is answered
  // once here instead of in every lock.
  const billingEnabled = useBillingEnabled();
  const [serviceFeatures, setServiceFeatures] = useState<Record<string, boolean>>({});
  const [isLoaded, setIsLoaded] = useState(false);
  const [supportAlias, setSupportAlias] = useState(DEFAULT_SUPPORT_ALIAS);
  const [supportAliases, setSupportAliases] = useState<string[]>([DEFAULT_SUPPORT_ALIAS]);
  const [deployTarget, setDeployTarget] = useState('local');
  const [tierPresets, setTierPresets] = useState<ServerTierPresets | undefined>(undefined);

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
          if (res.data.tierPresets) setTierPresets(res.data.tierPresets);
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

    const superAdmin = isSystemAdmin(user);

    // Sysadmins don't need their own billing tab — they manage billing for
    // every org, not pay one themselves.
    if (superAdmin) {
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
      isSuperAdmin: superAdmin,
      // Both halves matter: the page is permission-gated (`billing:read`) AND
      // absent when the deployment runs billing off.
      canReachBilling: billingEnabled && hasPermission(user, 'billing:read'),
      supportAlias,
      supportAliases,
      deployTarget,
      tierPresets,
    };
  }, [serviceFeatures, user, isLoaded, billingEnabled, supportAlias, supportAliases, deployTarget, tierPresets]);

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
