// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level authentication guard hook.
 * Redirects unauthenticated users to the login page and optionally
 * enforces admin or system-admin role requirements.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from './useAuth';
import { isSystemAdmin, isOrgAdmin, hasPermission, isMutationPermission } from '@/lib/auth-helpers';

/** Options for configuring the auth guard's requirements. */
interface AuthGuardOptions {
  /** Require the user to be an org admin or system admin. */
  requireAdmin?: boolean;
  /** Require the user to be a system admin specifically. */
  requireSystemAdmin?: boolean;
  /** Require a specific fine-grained permission (RBAC). Superadmins bypass. */
  requirePermission?: string;
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
  const { user, isAuthenticated, isInitialized, isLoading, isReadOnly, logout, refreshUser } = useAuth();

  const isSuperAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const isAdmin = isSuperAdmin || isOrgAdminUser;

  const requireAdmin = options?.requireAdmin ?? false;
  const requireSystemAdmin = options?.requireSystemAdmin ?? false;
  const requirePermission = options?.requirePermission;
  const hasRequiredPermission = !requirePermission || hasPermission(user, requirePermission);

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
    if (requireSystemAdmin && !isSuperAdmin) {
      router.push('/dashboard');
      return;
    }
    if (!hasRequiredPermission) {
      router.push('/dashboard');
      return;
    }
  }, [isAuthenticated, isInitialized, isLoading, isAdmin, isSuperAdmin, hasRequiredPermission, router, requireAdmin, requireSystemAdmin]);

  const isReady = isInitialized && !isLoading && isAuthenticated && !!user
    && (!requireAdmin || isAdmin)
    && (!requireSystemAdmin || isSuperAdmin)
    && hasRequiredPermission;

  return {
    user,
    isReady,
    isAuthenticated,
    isSuperAdmin,
    isOrgAdminUser,
    isAdmin,
    /** True during a read-only sysadmin impersonation session — writes are
     *  blocked by the backend, so `can()` reports false for every mutation. */
    isReadOnly,
    /**
     * Fine-grained permission check for the active org (RBAC UI gating).
     *
     * During a read-only impersonation session, mutation permissions
     * (`:write`/`:manage`/`org:settings`) always report false so write controls
     * disable app-wide — the backend rejects every non-GET request under an
     * impersonation token, so an enabled write button is only a 403 dead-end.
     * Read permissions are unaffected.
     */
    can: (permission: string) =>
      hasPermission(user, permission) && !(isReadOnly && isMutationPermission(permission)),
    logout,
    refreshUser,
  };
}
