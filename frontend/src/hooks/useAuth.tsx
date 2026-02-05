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

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Check if we're in development mode
 */
const isDev = process.env.NODE_ENV === 'development';

/**
 * Development-only logger
 */
const devLog = (...args: unknown[]) => {
  if (isDev) {
    console.log('[Auth]', ...args);
  }
};

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
    devLog('refreshUser called, isAuthenticated:', api.isAuthenticated());
    try {
      if (api.isAuthenticated()) {
        devLog('Fetching profile...');
        const response = await api.getProfile();
        devLog('Profile response:', response);
        
        // Handle both response formats:
        // Backend returns: { success, statusCode, user: {...} }
        // Standardized format: { success, data: { user: {...} } }
        const rawUser = (response as any).user || response.data?.user;
        
        if (response.success && rawUser) {
          // Normalize user data - backend uses _id/sub, frontend uses id
          const userData: User = {
            id: rawUser.id || rawUser.sub || rawUser._id?.toString(),
            username: rawUser.username,
            email: rawUser.email,
            role: rawUser.role,
            organizationId: rawUser.organizationId || undefined,
            organizationName: rawUser.organizationName || undefined,
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
    } catch (error) {
      devLog('Failed to refresh user:', error);
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
   * Login with email/username and password
   */
  const login = useCallback(async (email: string, password: string) => {
    devLog('Login called');
    setIsLoading(true);
    
    try {
      const response = await api.login(email, password);
      devLog('Login response:', response);
      
      if (response.success) {
        devLog('Login successful, refreshing user...');
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
      
      // Registration successful - user should login
      devLog('Registration successful');
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
