import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useRouter } from 'next/router';
import { User, UserOrgMembership } from '@/types';
import api from '@/lib/api';
import { clearPluginCache } from './usePlugins';

/**
 * Auth context shape.
 *
 * Supports multi-org membership: `organizations` lists all orgs the user
 * belongs to (via UserOrganization), and `switchOrganization` re-issues
 * tokens scoped to a different org (calls `POST /auth/switch-org`).
 * After switching, `user.role` and `user.organizationId` reflect the new org.
 */
interface AuthContextType {
  user: User | null;
  /** All organizations the user belongs to, fetched from GET /user/organizations */
  organizations: UserOrgMembership[];
  isLoading: boolean;
  isAuthenticated: boolean;
  isInitialized: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, organizationName?: string, planId?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** Switch active organization. Re-issues tokens and refreshes user profile with the new org's role. */
  switchOrganization: (orgId: string) => Promise<void>;
}

/** Raw user shape from the backend (may use _id/sub instead of id) */
interface RawUserData {
  id?: string;
  sub?: string;
  _id?: { toString(): string };
  username: string;
  email: string;
  role: string;
  organizationId?: string;
  organizationName?: string;
  isSuperAdmin?: boolean;
  isEmailVerified?: boolean;
  tier?: string;
  features?: string[];
  featureOverrides?: Record<string, boolean>;
  createdAt?: string;
  updatedAt?: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<UserOrgMembership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const router = useRouter();

  /**
   * Refresh user profile from API
   * Uses useCallback to maintain stable reference
   */
  const refreshUser = useCallback(async () => {
    try {
      if (api.isAuthenticated()) {
        const response = await api.getProfile();

        const rawUser = response.data?.user as RawUserData | undefined;

        if (response.success && rawUser) {
          // Normalize user data - backend uses _id/sub, frontend uses id
          const userData: User = {
            id: rawUser.id || rawUser.sub || rawUser._id?.toString() || '',
            username: rawUser.username,
            email: rawUser.email,
            role: rawUser.role as User['role'],
            organizationId: rawUser.organizationId,
            organizationName: rawUser.organizationName,
            // Sysadmin claim from the JWT — gates sysadmin-only routes
            // (Registry, Build Queue, All Users, etc.) via isSystemAdmin().
            // Missing here previously, so the sidebar filter always saw false.
            isSuperAdmin: rawUser.isSuperAdmin === true,
            isEmailVerified: rawUser.isEmailVerified ?? false,
            tier: rawUser.tier as User['tier'],
            features: rawUser.features,
            featureOverrides: rawUser.featureOverrides,
            createdAt: rawUser.createdAt,
            updatedAt: rawUser.updatedAt,
          };
          
          setUser(userData);
          // Set organization ID for API requests
          if (userData.organizationId) {
            api.setOrganizationId(userData.organizationId);
          }
          // Profile endpoint never returns `organizations`; always fetch separately.
          try {
            const orgRes = await api.getUserOrganizations();
            const orgs = (orgRes.data?.organizations || []).map(o => ({
              id: o.organizationId,
              name: o.organizationName,
              slug: o.slug,
              role: o.role as UserOrgMembership['role'],
              parentOrgId: o.parentOrgId,
              tier: o.tier as UserOrgMembership['tier'],
            }));
            setOrganizations(orgs);
          } catch {
            setOrganizations([]);
          }
          return;
        }
      }
      setUser(null);
    } catch {
      setUser(null);
    }
  }, []);

  /**
   * Initialize auth state on mount
   */
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await refreshUser();
      setIsLoading(false);
      setIsInitialized(true);
    };
    init();
  }, [refreshUser]);

  /**
   * Re-check token freshness when the tab becomes visible again.
   * Browser timers are throttled in background tabs, so the scheduled
   * proactive refresh may not have fired while the user was away.
   */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && api.isAuthenticated()) {
        refreshUser();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refreshUser]);

  /**
   * Handle session expiry — API client fires this when refresh fails.
   * Redirects to login page and clears local state.
   */
  useEffect(() => {
    return api.onSessionExpired(() => {
      clearPluginCache();
      setUser(null);
      router.push('/?expired=1');
    });
  }, [router]);

  /**
   * Login with email/username and password
   */
  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);

    try {
      const response = await api.login(email, password);

      if (response.success) {
        await refreshUser();
        // Use Next.js router for client-side navigation
        router.push('/dashboard');
      } else {
        throw new Error(response.message || 'Login failed');
      }
    } finally {
      setIsLoading(false);
    }
  }, [refreshUser, router]);

  /**
   * Register new user
   */
  const register = useCallback(async (
    username: string,
    email: string,
    password: string,
    organizationName?: string,
    planId?: string
  ) => {
    setIsLoading(true);

    try {
      const response = await api.register(username, email, password, organizationName, planId);
      
      if (!response.success) {
        throw new Error(response.message || 'Registration failed');
      }
      
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Switch active organization — re-issues tokens and refreshes user profile.
   */
  const switchOrganization = useCallback(async (orgId: string) => {
    await api.switchOrganization(orgId);
    // Drop the previous org's cached plugins before loading the new org's
    // profile — the module-level plugin cache would otherwise leak Org A's
    // plugins into the Org B session.
    clearPluginCache();
    await refreshUser();
  }, [refreshUser]);

  /**
   * Logout user
   */
  const logout = useCallback(async () => {
    setIsLoading(true);
    
    try {
      await api.logout();
    } finally {
      clearPluginCache();
      setUser(null);
      setIsLoading(false);
      // Navigate to landing page
      router.push('/');
    }
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        organizations,
        isLoading,
        isAuthenticated: !!user,
        isInitialized,
        login,
        register,
        logout,
        refreshUser,
        switchOrganization,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook to access auth context
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
