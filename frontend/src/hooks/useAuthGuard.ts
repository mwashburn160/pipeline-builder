/**
 * Route-level authentication guard hook.
 * Redirects unauthenticated users to the login page and optionally
 * enforces admin or system-admin role requirements.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from './useAuth';
import { isSystemAdmin, isSystemOrg as checkSystemOrg, isOrgAdmin } from '@/types';

/** Options for configuring the auth guard's role requirements. */
interface AuthGuardOptions {
  /** Require the user to be an org admin or system admin. */
  requireAdmin?: boolean;
  /** Require the user to be a system admin specifically. */
  requireSystemAdmin?: boolean;
}

/**
 * Guards a page route by checking authentication and role requirements.
 * Redirects to `/` (landing page) if not authenticated, or to `/dashboard` if
 * the user lacks the required admin privileges.
 *
 * @param options - Optional role requirements (admin, system admin)
 * @returns User info, role flags, readiness state, and auth action callbacks
 */
export function useAuthGuard(options?: AuthGuardOptions) {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading, logout, refreshUser } = useAuth();

  const isSystemOrg = checkSystemOrg(user);
  const isSysAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const isAdmin = isSysAdmin || isOrgAdminUser;

  const requireAdmin = options?.requireAdmin ?? false;
  const requireSystemAdmin = options?.requireSystemAdmin ?? false;

  useEffect(() => {
    if (!isInitialized || isLoading) return;
    if (!isAuthenticated) {
      router.push('/');
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
    isSystemOrg,
    isSysAdmin,
    isOrgAdminUser,
    isAdmin,
    logout,
    refreshUser,
  };
}
