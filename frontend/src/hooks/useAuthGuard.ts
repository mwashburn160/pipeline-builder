import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from './useAuth';
import { isSystemAdmin, isOrgAdmin } from '@/types';

interface AuthGuardOptions {
  requireAdmin?: boolean;
  requireSystemAdmin?: boolean;
}

export function useAuthGuard(options?: AuthGuardOptions) {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading, logout, refreshUser } = useAuth();

  const isSysAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const isAdmin = isSysAdmin || isOrgAdminUser;

  const requireAdmin = options?.requireAdmin ?? false;
  const requireSystemAdmin = options?.requireSystemAdmin ?? false;

  useEffect(() => {
    if (!isInitialized || isLoading) return;
    if (!isAuthenticated) {
      router.push('/auth/login');
      return;
    }
    if (requireAdmin && !isAdmin) {
      router.push('/dashboard');
      return;
    }
    if (requireSystemAdmin && !isSysAdmin) {
      router.push('/dashboard');
      return;
    }
  }, [isAuthenticated, isInitialized, isLoading, isAdmin, isSysAdmin, router, requireAdmin, requireSystemAdmin]);

  const isReady = isInitialized && !isLoading && isAuthenticated && !!user
    && (!requireAdmin || isAdmin)
    && (!requireSystemAdmin || isSysAdmin);

  return {
    user,
    isReady,
    isAuthenticated,
    isSysAdmin,
    isOrgAdminUser,
    isAdmin,
    logout,
    refreshUser,
  };
}
