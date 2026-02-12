import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useRouter } from 'next/router';
import { User } from '@/types';
import api from '@/lib/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isInitialized: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, organizationName?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
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
  isEmailVerified?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
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
            isEmailVerified: rawUser.isEmailVerified ?? false,
            createdAt: rawUser.createdAt,
            updatedAt: rawUser.updatedAt,
          };
          
          setUser(userData);
          // Set organization ID for API requests
          if (userData.organizationId) {
            api.setOrganizationId(userData.organizationId);
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
    organizationName?: string
  ) => {
    setIsLoading(true);
    
    try {
      const response = await api.register(username, email, password, organizationName);
      
      if (!response.success) {
        throw new Error(response.message || 'Registration failed');
      }
      
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Logout user
   */
  const logout = useCallback(async () => {
    setIsLoading(true);
    
    try {
      await api.logout();
    } finally {
      setUser(null);
      setIsLoading(false);
      // Use Next.js router for client-side navigation
      router.push('/auth/login');
    }
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        isInitialized,
        login,
        register,
        logout,
        refreshUser,
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

/**
 * HOC to require authentication for a page
 */
export function withAuth<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  options: { redirectTo?: string } = {}
) {
  const { redirectTo = '/auth/login' } = options;

  return function AuthenticatedComponent(props: P) {
    const { isAuthenticated, isInitialized, isLoading } = useAuth();
    const router = useRouter();

    useEffect(() => {
      if (isInitialized && !isLoading && !isAuthenticated) {
        router.push(redirectTo);
      }
    }, [isAuthenticated, isInitialized, isLoading, router]);

    // Show nothing while checking auth
    if (!isInitialized || isLoading) {
      return null;
    }

    // Show nothing while redirecting
    if (!isAuthenticated) {
      return null;
    }

    return <WrappedComponent {...props} />;
  };
}
