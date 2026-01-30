import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User } from '@/types';
import api from '@/lib/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = async () => {
    console.log('[Auth] refreshUser called, isAuthenticated:', api.isAuthenticated());
    try {
      if (api.isAuthenticated()) {
        console.log('[Auth] Fetching profile...');
        const response = await api.getProfile();
        console.log('[Auth] Profile response:', response);
        // Handle both { data: user } and { user: user } response formats
        const userData = (response.data || (response as any).user) as User;
        if (response.success && userData) {
          setUser(userData);
          // Set organization ID for API requests
          if (userData.organizationId) {
            api.setOrganizationId(userData.organizationId);
          }
        }
      }
    } catch (error) {
      console.error('[Auth] Failed to refresh user:', error);
      setUser(null);
    }
  };

  useEffect(() => {
    const init = async () => {
      await refreshUser();
      setIsLoading(false);
    };
    init();
  }, []);

  const login = async (email: string, password: string) => {
    console.log('[Auth] Login called');
    const response = await api.login(email, password);
    console.log('[Auth] Login response:', response);
    if (response.success) {
      console.log('[Auth] Login successful, refreshing user...');
      // Fetch user profile after successful login
      await refreshUser();
      console.log('[Auth] User refreshed, user:', user);
    } else {
      throw new Error(response.message || 'Login failed');
    }
  };

  const register = async (username: string, email: string, password: string) => {
    const response = await api.register(username, email, password);
    if (!response.success) {
      throw new Error(response.message || 'Registration failed');
    }
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
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

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
